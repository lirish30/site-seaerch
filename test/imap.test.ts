import { describe, expect, it } from "vitest";
import {
  buildFetchBody, buildFetchSizes, buildLogin, fetchImapOver, imapQuote, MAX_MESSAGE_BYTES, newMessages, parseImapFetch,
  parseImapSizes, parseSelect, planBodies, planWindow, probeImapOver, redact, scanResponse, WINDOW, type ImapSocket,
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

describe("parseImapSizes", () => {
  it("reads uid and size pairs", () => {
    expect(parseImapSizes(b("* 1 FETCH (UID 41 RFC822.SIZE 1234)\r\n* 2 FETCH (RFC822.SIZE 55 UID 42 FLAGS (\\Seen))\r\nA2 OK done\r\n")))
      .toEqual([{ uid: 41, size: 1234 }, { uid: 42, size: 55 }]);
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

  it("asks for an explicit UID range and one body at a time, never n:*", () => {
    expect(buildFetchSizes("A3", 42, 66)).toBe("A3 UID FETCH 42:66 (UID RFC822.SIZE)\r\n");
    expect(buildFetchBody("A4", 42)).toBe("A4 UID FETCH 42 (UID BODY.PEEK[])\r\n");
  });
});

describe("planning", () => {
  it("no window when nothing is new", () => {
    expect(planWindow(43, 44)).toBeNull();
    expect(planWindow(50, 44)).toBeNull();
    expect(planWindow(0, 1)).toBeNull();
  });

  it("window starts after sinceUid and is bounded by WINDOW and uidNext - 1", () => {
    expect(planWindow(43, 46)).toEqual({ from: 44, to: 45 });
    expect(planWindow(100, 10_000)).toEqual({ from: 101, to: 100 + WINDOW });
  });

  it("skips oversized messages and reports them, keeping the window end as highestUid", () => {
    const plan = planBodies([{ uid: 5, size: 100 }, { uid: 6, size: MAX_MESSAGE_BYTES + 1 }, { uid: 7, size: 200 }], 9);
    expect(plan).toEqual({ fetch: [5, 7], skipped: [{ uid: 6, size: MAX_MESSAGE_BYTES + 1 }], highestUid: 9 });
  });

  it("stops at the batch budget and stops highestUid just before the first message left for next time", () => {
    const sizes = [{ uid: 5, size: 60 }, { uid: 6, size: 60 }, { uid: 7, size: 10 }];
    expect(planBodies(sizes, 9, 1000, 100)).toEqual({ fetch: [5], skipped: [], highestUid: 5 });
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
interface FakeMsg { uid: number; raw: string; size?: number }
function fakeServer(opts: {
  greeting?: string; login?: "OK" | "NO"; messages?: FakeMsg[]; uidNext?: number; starttls?: "ok" | "refuse"; silent?: boolean;
}) {
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  const out = toClient.writable.getWriter();
  // Deliver in small pieces so responses arrive across many reads.
  const send = async (s: string | Uint8Array) => {
    const all = typeof s === "string" ? b(s) : s;
    for (let i = 0; i < all.length; i += 700) await out.write(all.slice(i, i + 700));
  };
  const seen: string[] = [];
  const msgs = opts.messages ?? [];
  const uidNext = opts.uidNext ?? 44;
  const inRange = (spec: string, uid: number) => {
    const [lo, hi] = spec.split(":");
    if (hi === undefined) return uid === Number(lo);
    if (hi === "*") return uid >= Number(lo) || uid === Math.max(...msgs.map((m) => m.uid)); // a real server returns the newest for n:*
    return uid >= Number(lo) && uid <= Number(hi);
  };
  void (async () => {
    if (opts.silent) return; // accepts the connection, never says a word
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
        seen.push(line);
        const [tag, cmd, , spec, attrs] = line.split(" ");
        if (cmd === "STARTTLS") await send(opts.starttls === "refuse" ? `${tag} NO [UNAVAILABLE] TLS not available\r\n` : `${tag} OK Begin TLS\r\n`);
        else if (cmd === "LOGIN") await send(opts.login === "NO" ? `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials for ${line}\r\n` : `${tag} OK Logged in\r\n`);
        else if (cmd === "SELECT") await send(`* 3 EXISTS\r\n* OK [UIDVALIDITY 777] ok\r\n* OK [UIDNEXT ${uidNext}] next\r\n${tag} OK [READ-WRITE] Select done\r\n`);
        else if (cmd === "UID") {
          const hit = msgs.filter((m) => inRange(spec, m.uid));
          let body = "";
          for (const m of hit) {
            body += line.includes("RFC822.SIZE")
              ? `* ${m.uid} FETCH (UID ${m.uid} RFC822.SIZE ${m.size ?? b(m.raw).length})\r\n`
              : `* ${m.uid} FETCH (UID ${m.uid} BODY[] {${b(m.raw).length}}\r\n${m.raw})\r\n`;
          }
          void attrs;
          await send(`${body}${tag} OK Fetch done\r\n`);
        } else if (cmd === "LOGOUT") { await send(`* BYE bye\r\n${tag} OK Logout\r\n`); await out.close(); return; }
      }
    }
  })();
  const socket: ImapSocket = {
    readable: toClient.readable, writable: toServer.writable,
    startTls: opts.starttls ? () => socket : undefined,
    close: async () => {},
  };
  return { socket, seen };
}

const mb = (over: Partial<Mailbox> = {}): Mailbox => ({
  key: "outreach", enabled: 1, smtp_host: "smtp.test", smtp_port: 465, imap_host: "imap.test", imap_port: 993,
  username: "outreach@hellositeline.test", from_email: "outreach@hellositeline.test", from_name: "Logan",
  warmup_started_at: null, imap_uid_validity: null, imap_last_uid: null, last_sync_at: null, last_sync_error: null, ...over,
});
const cmds = (seen: string[]) => seen.map((l) => l.split(" ")[1]);

describe("fetchImapOver (fake server)", () => {
  const messages: FakeMsg[] = [{ uid: 43, raw: msgA }, { uid: 44, raw: msgB }];

  it("with sinceUid null returns only the baseline and fetches nothing", async () => {
    const s = fakeServer({ messages });
    const out = await fetchImapOver(() => s.socket, mb(), "pw", null);
    expect(out).toEqual({ uidValidity: 777, uidNext: 44, messages: [], skipped: [], highestUid: 43 });
    expect(cmds(s.seen)).toEqual(["LOGIN", "SELECT", "LOGOUT"]);
  });

  it("no fetch when nothing is new", async () => {
    const s = fakeServer({ messages: [{ uid: 43, raw: msgA }] }); // uidNext 44: the newest message is 43
    const out = await fetchImapOver(() => s.socket, mb(), "pw", 43);
    expect(out).toEqual({ uidValidity: 777, uidNext: 44, messages: [], skipped: [], highestUid: 43 });
    expect(s.seen.some((l) => l.includes("FETCH"))).toBe(false);
  });

  it("fetches an explicit window not n:*", async () => {
    const s = fakeServer({ messages, uidNext: 45 });
    const out = await fetchImapOver(() => s.socket, mb(), "pw", 42);
    expect(out.messages.map((m) => m.uid)).toEqual([43, 44]);
    expect(dec.decode(out.messages[1].raw)).toBe(msgB);
    expect(out.highestUid).toBe(44);
    expect(s.seen).toContain("A3 UID FETCH 43:44 (UID RFC822.SIZE)");
    expect(s.seen).toContain("A4 UID FETCH 43 (UID BODY.PEEK[])");
    expect(s.seen).toContain("A5 UID FETCH 44 (UID BODY.PEEK[])");
    expect(s.seen.some((l) => l.includes(":*"))).toBe(false);
  });

  it("bounds the window to WINDOW messages", async () => {
    const s = fakeServer({ messages: [], uidNext: 1000 });
    const out = await fetchImapOver(() => s.socket, mb(), "pw", 100);
    expect(s.seen).toContain(`A3 UID FETCH 101:${100 + WINDOW} (UID RFC822.SIZE)`);
    expect(out.highestUid).toBe(100 + WINDOW); // an all-expunged window still advances
  });

  it("oversized message is skipped, reported, and highestUid advances past it", async () => {
    const s = fakeServer({ messages: [{ uid: 43, raw: "x", size: MAX_MESSAGE_BYTES + 1 }], uidNext: 44 });
    const out = await fetchImapOver(() => s.socket, mb(), "pw", 42);
    expect(out.messages).toEqual([]);
    expect(out.skipped).toEqual([{ uid: 43, size: MAX_MESSAGE_BYTES + 1 }]);
    expect(out.highestUid).toBe(43);
    expect(s.seen.some((l) => l.includes("BODY.PEEK"))).toBe(false); // body never downloaded
  });

  it("later small message after an oversized one is still returned", async () => {
    const s = fakeServer({ messages: [{ uid: 43, raw: "x", size: MAX_MESSAGE_BYTES + 1 }, { uid: 44, raw: msgB }], uidNext: 45 });
    const out = await fetchImapOver(() => s.socket, mb(), "pw", 42);
    expect(out.messages.map((m) => m.uid)).toEqual([44]);
    expect(out.skipped.map((m) => m.uid)).toEqual([43]);
    expect(out.highestUid).toBe(44);
  });

  it("reassembles a large message delivered across many reads", async () => {
    const big = crlf("Subject: big\n\n" + "line of text that repeats\n".repeat(8000)); // ~200 KB
    const s = fakeServer({ messages: [{ uid: 43, raw: big }], uidNext: 44 });
    const out = await fetchImapOver(() => s.socket, mb(), "pw", 42);
    expect(out.messages).toHaveLength(1);
    expect(dec.decode(out.messages[0].raw)).toBe(big);
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
    const s = fakeServer({ starttls: "ok" });
    await fetchImapOver(() => s.socket, mb({ imap_port: 143 }), "pw", null);
    expect(cmds(s.seen)).toEqual(["STARTTLS", "LOGIN", "SELECT", "LOGOUT"]);
  });

  it("a STARTTLS refusal sends no LOGIN", async () => {
    const s = fakeServer({ starttls: "refuse" });
    await expect(fetchImapOver(() => s.socket, mb({ imap_port: 143 }), "pw", null)).rejects.toThrow(/STARTTLS failed/);
    expect(s.seen.some((l) => l.includes("LOGIN"))).toBe(false);
  });

  it("fails clearly when the server greeting is not OK", async () => {
    const s = fakeServer({ greeting: "* BYE go away\r\n" });
    await expect(fetchImapOver(() => s.socket, mb(), "pw", null)).rejects.toThrow(/greeting/);
  });

  it("a hung server times out instead of hanging", async () => {
    const s = fakeServer({ silent: true });
    await expect(fetchImapOver(() => s.socket, mb(), "pw", null, { readTimeoutMs: 40, closeTimeoutMs: 40 })).rejects.toThrow(/stopped responding/);
  });

  it("rejects a response bigger than the cap", async () => {
    const s = fakeServer({ messages: [{ uid: 43, raw: "y".repeat(5000) }], uidNext: 44 });
    await expect(fetchImapOver(() => s.socket, mb(), "pw", 42, { maxResponseBytes: 1000 })).rejects.toThrow(/too large/);
  });
});
