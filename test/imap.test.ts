import { describe, expect, it } from "vitest";
import {
  buildFetch, buildLogin, fetchImapOver, imapQuote, newMessages, parseImapFetch, parseSelect,
  probeImapOver, redact, scanResponse, type ImapSocket,
} from "../src/worker/mail/imap";
import type { Mailbox } from "../src/worker/mail/types";

const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string) => enc.encode(s);
const crlf = (s: string) => s.replace(/\n/g, "\r\n");

const msgA = crlf("Subject: one\n\nhello\n");
// A literal that contains CRLF, a fake tagged response and a fake FETCH line: only a byte count can skip it.
const msgB = crlf("Subject: two\n\nA2 OK FETCH completed\n* 9 FETCH (UID 999 BODY[] {5}\n)\nend\n");

const transcript =
  `* 2 FETCH (UID 41 BODY[] {${b(msgA).length}}\r\n${msgA} FLAGS (\\Seen))\r\n` +
  `* 3 FETCH (BODY[] {${b(msgB).length}}\r\n${msgB} UID 42)\r\n` +
  `* 4 FETCH (UID 43 FLAGS () BODY[] "quoted \\"body\\"")\r\n` +
  `A3 OK UID FETCH completed\r\n`;

describe("parseImapFetch", () => {
  it("parseImapFetch handles literals and multiple messages", () => {
    const out = parseImapFetch(b(transcript));
    expect(out.map((m) => m.uid)).toEqual([41, 42, 43]);
    expect(dec.decode(out[0].raw)).toBe(msgA);
    expect(dec.decode(out[1].raw)).toBe(msgB);
    expect(dec.decode(out[2].raw)).toBe('quoted "body"');
  });

  it("keeps binary literal bytes intact", () => {
    const body = Uint8Array.from([0, 1, 13, 10, 255, 254, 41, 13, 10]);
    const head = b(`* 1 FETCH (UID 7 BODY[] {${body.length}}\r\n`);
    const tail = b(")\r\nA1 OK done\r\n");
    const all = new Uint8Array(head.length + body.length + tail.length);
    all.set(head); all.set(body, head.length); all.set(tail, head.length + body.length);
    const out = parseImapFetch(all);
    expect(out).toHaveLength(1);
    expect(Array.from(out[0].raw)).toEqual(Array.from(body));
  });

  it("ignores other untagged lines and skips entries without a uid or body", () => {
    const t = "* 5 EXISTS\r\n* 5 RECENT\r\n* 1 FETCH (FLAGS (\\Seen))\r\n* 2 FETCH (UID 8 BODY[] NIL)\r\nA1 OK done\r\n";
    expect(parseImapFetch(b(t))).toEqual([]);
  });

  it("parses a FETCH that follows other untagged lines", () => {
    const t = `* 3 EXISTS\r\n* 3 FETCH (UID 9 BODY[] {2}\r\nhi)\r\nA1 OK done\r\n`;
    expect(parseImapFetch(b(t)).map((m) => m.uid)).toEqual([9]);
  });

  it("stops on malformed input instead of looping", () => {
    expect(parseImapFetch(b("* 1 FETCH (UID 5\r\n\r\n"))).toEqual([]);
    expect(parseImapFetch(b("* 1 FETCH (UID 5 BODY[] {zz}\r\n)\r\n"))).toEqual([]);
  });

  it("returns what it has when the input is truncated", () => {
    const out = parseImapFetch(b(`* 1 FETCH (UID 9 BODY[] {50}\r\nshort`));
    expect(out).toEqual([]);
  });
});

describe("scanResponse", () => {
  it("finds the tagged line and skips tagged-looking text inside literals", () => {
    const r = scanResponse(b(transcript), "A3");
    expect(r?.status).toBe("OK");
    expect(r?.end).toBe(b(transcript).length);
    expect(r?.body.length).toBe(b(transcript).length - "A3 OK UID FETCH completed\r\n".length);
  });

  it("is incomplete until the tagged line and the whole literal have arrived", () => {
    const all = b(transcript);
    expect(scanResponse(all.slice(0, all.length - 5), "A3")).toBeNull();
    expect(scanResponse(all.slice(0, 40), "A3")).toBeNull();
    const fake = b(`* 1 FETCH (UID 1 BODY[] {40}\r\nA3 OK not the end\r\n`);
    expect(scanResponse(fake, "A3")).toBeNull();
  });

  it("reports NO and BAD", () => {
    expect(scanResponse(b("A1 NO [AUTHENTICATIONFAILED] bad credentials\r\n"), "A1")).toMatchObject({ status: "NO", text: "[AUTHENTICATIONFAILED] bad credentials" });
    expect(scanResponse(b("* OK hi\r\nA1 BAD nope\r\n"), "A1")?.status).toBe("BAD");
  });
});

describe("command builders", () => {
  it("quotes and escapes LOGIN arguments", () => {
    expect(imapQuote('pa"ss\\word')).toBe('"pa\\"ss\\\\word"');
    expect(buildLogin("A1", "me@example.test", 'p"w\\')).toBe('A1 LOGIN "me@example.test" "p\\"w\\\\"\r\n');
  });

  it("rejects characters that cannot go in a quoted string", () => {
    expect(() => imapQuote("a\r\nA9 LOGOUT")).toThrow(/invalid character/);
    expect(() => imapQuote("a\0b")).toThrow(/invalid character/);
  });

  it("asks for everything after the last seen uid without marking read", () => {
    expect(buildFetch("A3", 41)).toBe("A3 UID FETCH 42:* (UID BODY.PEEK[])\r\n");
    expect(buildFetch("A3", 0)).toBe("A3 UID FETCH 1:* (UID BODY.PEEK[])\r\n");
  });
});

describe("parseSelect / newMessages / redact", () => {
  it("reads UIDVALIDITY and UIDNEXT", () => {
    expect(parseSelect("* 4 EXISTS\r\n* OK [UIDVALIDITY 3857529045] UIDs valid\r\n* OK [UIDNEXT 44] Predicted next UID\r\n")).toEqual({ uidValidity: 3857529045, uidNext: 44 });
    expect(() => parseSelect("* 4 EXISTS\r\n")).toThrow(/UIDVALIDITY/);
  });

  it("filters out messages at or below sinceUid and sorts by uid", () => {
    const m = (uid: number) => ({ uid, raw: new Uint8Array() });
    expect(newMessages([m(50), m(41), m(42)], 41).map((x) => x.uid)).toEqual([42, 50]);
    expect(newMessages([m(41)], 41)).toEqual([]);
  });

  it("redacts the password, including its escaped form", () => {
    expect(redact('bad login "s3cr\\"t" and s3cr"t', 's3cr"t')).not.toContain("s3cr");
    expect(redact("nothing here", "")).toBe("nothing here");
  });
});

// A scripted in-memory IMAP server over TransformStreams.
function fakeServer(opts: { greeting?: string; login?: "OK" | "NO"; fetchBody?: string; onCommand?: (line: string) => void; starttls?: boolean }) {
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const out = toClient.writable.getWriter();
  const send = (s: string | Uint8Array) => out.write(typeof s === "string" ? b(s) : s);
  const seen: string[] = [];
  let tls = false;
  void (async () => {
    await send(opts.greeting ?? "* OK IMAP ready\r\n");
    const reader = toServer.readable.getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        seen.push(line); opts.onCommand?.(line);
        const [tag, cmd] = line.split(" ");
        if (cmd === "STARTTLS") { tls = true; await send(`${tag} OK Begin TLS\r\n`); }
        else if (cmd === "LOGIN") await send(opts.login === "NO" ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials for ${line}\r\n` : `${tag} OK Logged in\r\n`);
        else if (cmd === "SELECT") await send(`* 3 EXISTS\r\n* OK [UIDVALIDITY 777] ok\r\n* OK [UIDNEXT 44] next\r\n${tag} OK [READ-WRITE] Select done\r\n`);
        else if (cmd === "UID") await send((opts.fetchBody ?? "") + `${tag} OK Fetch done\r\n`);
        else if (cmd === "LOGOUT") { await send(`* BYE bye\r\n${tag} OK Logout\r\n`); await out.close(); return; }
      }
    }
  })();
  const socket: ImapSocket = {
    readable: toClient.readable, writable: toServer.writable,
    startTls: opts.starttls ? () => socket : undefined,
    close: async () => {},
  };
  return { socket, seen, get tls() { return tls; } };
}

const mb = (over: Partial<Mailbox> = {}): Mailbox => ({
  key: "outreach", enabled: 1, smtp_host: "smtp.test", smtp_port: 465, imap_host: "imap.test", imap_port: 993,
  username: "outreach@hellositeline.test", from_email: "outreach@hellositeline.test", from_name: "Logan",
  warmup_started_at: null, imap_uid_validity: null, imap_last_uid: null, last_sync_at: null, last_sync_error: null, ...over,
});

describe("fetchImapOver (fake server)", () => {
  const fetchBody =
    `* 1 FETCH (UID 43 BODY[] {${b(msgA).length}}\r\n${msgA})\r\n` +
    `* 2 FETCH (UID 44 BODY[] {${b(msgB).length}}\r\n${msgB})\r\n`;

  it("with sinceUid null returns only the baseline and fetches nothing", async () => {
    const s = fakeServer({});
    const out = await fetchImapOver(() => s.socket, mb(), "pw", null);
    expect(out).toEqual({ uidValidity: 777, uidNext: 44, messages: [] });
    expect(s.seen.some((l) => l.includes("UID FETCH"))).toBe(false);
    expect(s.seen.map((l) => l.split(" ")[1])).toEqual(["LOGIN", "SELECT", "LOGOUT"]);
  });

  it("returns only messages above sinceUid even though n:* always returns the last one", async () => {
    const s = fakeServer({ fetchBody });
    const out = await fetchImapOver(() => s.socket, mb(), "pw", 43);
    expect(out.messages.map((m) => m.uid)).toEqual([44]);
    expect(dec.decode(out.messages[0].raw)).toBe(msgB);
    expect(s.seen).toContain("A3 UID FETCH 44:* (UID BODY.PEEK[])");
  });

  it("sends a password with quotes and backslashes as an escaped quoted string", async () => {
    const s = fakeServer({});
    await fetchImapOver(() => s.socket, mb(), 'p"w\\x', null);
    expect(s.seen[0]).toBe('A1 LOGIN "outreach@hellositeline.test" "p\\"w\\\\x"');
  });

  it("never leaks the password in a login failure", async () => {
    const s = fakeServer({ login: "NO" });
    const err = await fetchImapOver(() => s.socket, mb(), "hunter2-secret", null).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/AUTHENTICATIONFAILED/);
    expect((err as Error).message).not.toContain("hunter2-secret");
  });

  it("probe logs in and selects without fetching", async () => {
    const s = fakeServer({});
    expect(await probeImapOver(() => s.socket, mb(), "pw")).toEqual({ uidValidity: 777 });
    expect(s.seen.some((l) => l.includes("FETCH"))).toBe(false);
  });

  it("upgrades with STARTTLS before logging in on a non-993 port", async () => {
    const s = fakeServer({ starttls: true });
    await fetchImapOver(() => s.socket, mb({ imap_port: 143 }), "pw", null);
    expect(s.seen.map((l) => l.split(" ")[1])).toEqual(["STARTTLS", "LOGIN", "SELECT", "LOGOUT"]);
  });

  it("fails clearly when the server greeting is not OK", async () => {
    const s = fakeServer({ greeting: "* BYE go away\r\n" });
    await expect(fetchImapOver(() => s.socket, mb(), "pw", null)).rejects.toThrow(/greeting/);
  });
});
