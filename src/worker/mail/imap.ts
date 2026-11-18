import { connect } from "cloudflare:sockets";
import type { ImapFetch, ImapProbe, Mailbox } from "./types";

/**
 * A minimal IMAP client: LOGIN, SELECT INBOX, UID FETCH, LOGOUT (plus STARTTLS off port 993).
 * Everything with a decision in it is a pure function below; only ImapSession touches a socket.
 */

const enc = new TextEncoder();
const dec = new TextDecoder("latin1");
const CRLF = new Uint8Array([13, 10]);

// ---------- pure helpers ----------

/** IMAP quoted string. CR, LF and NUL cannot appear in one; everything else is escaped or sent as UTF-8. */
export function imapQuote(s: string): string {
  if (/[\r\n\0]/.test(s)) throw new Error("IMAP argument contains an invalid character");
  return `"${s.replace(/[\\"]/g, "\\$&")}"`;
}

export const buildLogin = (tag: string, user: string, pass: string): string => `${tag} LOGIN ${imapQuote(user)} ${imapQuote(pass)}\r\n`;
export const buildSelect = (tag: string): string => `${tag} SELECT INBOX\r\n`;
/** `n:*` always yields the last message even when n is past it, so callers must still filter on uid. */
export const buildFetch = (tag: string, sinceUid: number): string => `${tag} UID FETCH ${sinceUid + 1}:* (UID BODY.PEEK[])\r\n`;

/** Replaces the password (and its quoted form) in text that may be shown to a user. */
export function redact(text: string, password: string): string {
  if (!password) return text;
  return text.split(password.replace(/[\\"]/g, "\\$&")).join("***").split(password).join("***");
}

export function parseSelect(text: string): { uidValidity: number; uidNext: number } {
  const validity = /\[UIDVALIDITY (\d+)\]/i.exec(text)?.[1];
  const next = /\[UIDNEXT (\d+)\]/i.exec(text)?.[1];
  if (!validity) throw new Error("IMAP server did not report UIDVALIDITY");
  if (!next) throw new Error("IMAP server did not report UIDNEXT");
  return { uidValidity: Number(validity), uidNext: Number(next) };
}

export const newMessages = <T extends { uid: number }>(all: T[], sinceUid: number): T[] =>
  all.filter((m) => m.uid > sinceUid).sort((a, b) => a.uid - b.uid);

function indexOfCrlf(buf: Uint8Array, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) if (buf[i] === 13 && buf[i + 1] === 10) return i;
  return -1;
}

const LITERAL_AT_END = /\{(\d+)\+?\}$/;
const ascii = (buf: Uint8Array, from: number, to: number): string => dec.decode(buf.subarray(from, to));

export interface ScanResult { status: "OK" | "NO" | "BAD"; text: string; body: Uint8Array; end: number }

/**
 * Finds the tagged completion line of a command in `buf`, or null if it has not fully arrived.
 * Literals ({N} then N bytes) are skipped by byte count, so text inside a message that looks like
 * a tagged response is never mistaken for one.
 */
export function scanResponse(buf: Uint8Array, tag: string): ScanResult | null {
  let pos = 0;
  for (;;) {
    const eol = indexOfCrlf(buf, pos);
    if (eol < 0) return null;
    const line = ascii(buf, pos, eol);
    if (line.startsWith(`${tag} `)) {
      const m = /^\S+ (OK|NO|BAD)\b ?(.*)$/i.exec(line);
      return { status: (m?.[1]?.toUpperCase() ?? "BAD") as ScanResult["status"], text: m?.[2] ?? line, body: buf.slice(0, pos), end: eol + 2 };
    }
    const lit = LITERAL_AT_END.exec(line);
    if (lit) {
      const after = eol + 2 + Number(lit[1]);
      if (buf.length < after) return null;
      pos = after;
    } else {
      pos = eol + 2;
    }
  }
}

/** Cursor over a response buffer. Throws RangeError past the end so truncated input stops the parse. */
class Cursor {
  p = 0;
  constructor(readonly b: Uint8Array) {}
  get done(): boolean { return this.p >= this.b.length; }
  peek(): number { if (this.done) throw new RangeError("end of input"); return this.b[this.p]; }
  skipSpaces(): void { while (!this.done && this.b[this.p] === 32) this.p++; }
  atom(): string {
    const start = this.p;
    while (!this.done && ![32, 40, 41, 13, 10].includes(this.b[this.p])) this.p++;
    return ascii(this.b, start, this.p);
  }
  /** `{N}` or `{N+}` then CRLF then N bytes. */
  literal(): Uint8Array {
    const close = this.b.indexOf(125, this.p);
    if (close < 0) throw new RangeError("bad literal");
    const n = Number(ascii(this.b, this.p + 1, close).replace("+", ""));
    const start = close + 3; // past "}" CR LF
    if (!Number.isInteger(n) || this.b[close + 1] !== 13 || this.b[close + 2] !== 10 || start + n > this.b.length) throw new RangeError("bad literal");
    this.p = start + n;
    return this.b.slice(start, start + n);
  }
  quoted(): Uint8Array {
    const out: number[] = [];
    this.p++; // opening quote
    for (;;) {
      const c = this.peek(); this.p++;
      if (c === 34) break;
      if (c === 92) { out.push(this.peek()); this.p++; } else out.push(c);
    }
    return Uint8Array.from(out);
  }
  /** One value: literal, quoted string, parenthesised list (skipped, returns null), NIL, or atom. */
  value(): Uint8Array | null {
    const c = this.peek();
    if (c === 123) return this.literal();
    if (c === 34) return this.quoted();
    if (c === 40) {
      this.p++;
      for (this.skipSpaces(); this.peek() !== 41; this.skipSpaces()) {
        const before = this.p;
        if (this.peek() === 40 || this.peek() === 123 || this.peek() === 34) this.value(); else this.atom();
        if (this.p === before) throw new RangeError("malformed list");
      }
      this.p++;
      return null;
    }
    const a = this.atom();
    return a.toUpperCase() === "NIL" ? null : enc.encode(a);
  }
  toLineEnd(): void { const e = indexOfCrlf(this.b, this.p); this.p = e < 0 ? this.b.length : e + 2; }
}

/**
 * Parses the untagged `* n FETCH (UID u BODY[] {N}...)` responses out of a UID FETCH reply.
 * Messages come back in server order; entries lacking a UID or a body are dropped. Truncated input
 * yields the messages that were complete.
 */
export function parseImapFetch(bytes: Uint8Array): { uid: number; raw: Uint8Array }[] {
  const out: { uid: number; raw: Uint8Array }[] = [];
  const c = new Cursor(bytes);
  try {
    while (!c.done) {
      const eol = indexOfCrlf(bytes, c.p);
      if (eol < 0) break;
      const head = /^\* \d+ FETCH \(/i.exec(ascii(bytes, c.p, Math.min(eol, c.p + 40)));
      if (!head) {
        // Some other line (EXISTS, tagged completion...). Skip it, and its literal if it has one.
        const lit = LITERAL_AT_END.exec(ascii(bytes, c.p, eol));
        if (lit) { c.p = eol + 2 + Number(lit[1]); c.toLineEnd(); } else c.p = eol + 2;
        continue;
      }
      c.p += head[0].length;
      let uid: number | null = null;
      let raw: Uint8Array | null = null;
      for (c.skipSpaces(); c.peek() !== 41; c.skipSpaces()) {
        const before = c.p;
        const name = c.atom().toUpperCase();
        c.skipSpaces();
        const v = c.value();
        if (c.p === before) throw new RangeError("malformed FETCH response");
        if (name === "UID" && v) uid = Number(dec.decode(v));
        else if ((name.startsWith("BODY[") || name === "RFC822") && v) raw = v;
      }
      c.p++; // closing paren
      c.toLineEnd();
      if (uid !== null && Number.isInteger(uid) && raw) out.push({ uid, raw });
    }
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  return out;
}

// ---------- session over a socket-like ----------

export interface ImapSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls?(): ImapSocket;
  close(): Promise<void> | void;
}
export type ImapConnector = (host: string, port: number, secure: "on" | "starttls") => ImapSocket;

const READ_TIMEOUT_MS = 20_000;
const TOTAL_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

class ImapSession {
  private buf = new Uint8Array(0);
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private tagN = 0;
  private readonly deadline = Date.now() + TOTAL_TIMEOUT_MS;

  constructor(private socket: ImapSocket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  private async readChunk(): Promise<void> {
    const ms = Math.min(READ_TIMEOUT_MS, this.deadline - Date.now());
    if (ms <= 0) throw new Error("IMAP session timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("IMAP server stopped responding")), ms); });
    try {
      const { value, done } = await Promise.race([this.reader.read(), timeout]);
      if (done) throw new Error("IMAP connection closed unexpectedly");
      const next = new Uint8Array(this.buf.length + value.length);
      next.set(this.buf); next.set(value, this.buf.length);
      if (next.length > MAX_RESPONSE_BYTES) throw new Error("IMAP response too large");
      this.buf = next;
    } finally {
      clearTimeout(timer);
    }
  }

  async greeting(): Promise<void> {
    let eol: number;
    while ((eol = indexOfCrlf(this.buf, 0)) < 0) await this.readChunk();
    const line = ascii(this.buf, 0, eol);
    this.buf = this.buf.slice(eol + 2);
    if (!/^\* (OK|PREAUTH)\b/i.test(line)) throw new Error(`unexpected IMAP greeting: ${line.slice(0, 120)}`);
  }

  /** Sends one command and returns the untagged data that preceded its completion. Throws on NO/BAD. */
  async run(build: (tag: string) => string): Promise<Uint8Array> {
    const tag = `A${++this.tagN}`;
    const command = build(tag);
    await this.writer.write(enc.encode(command));
    for (;;) {
      const res = scanResponse(this.buf, tag);
      if (res) {
        this.buf = this.buf.slice(res.end);
        if (res.status !== "OK") throw new Error(`IMAP ${command.split(" ")[1]} failed: ${res.text}`);
        return res.body;
      }
      await this.readChunk();
    }
  }

  async startTls(): Promise<void> {
    await this.run((t) => `${t} STARTTLS\r\n`);
    if (!this.socket.startTls) throw new Error("socket cannot upgrade to TLS");
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = this.socket.startTls();
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buf = new Uint8Array(0);
  }

  async login(user: string, pass: string): Promise<void> { await this.run((t) => buildLogin(t, user, pass)); }
  async select(): Promise<{ uidValidity: number; uidNext: number }> { return parseSelect(dec.decode(await this.run(buildSelect))); }
  fetch(sinceUid: number): Promise<Uint8Array> { return this.run((t) => buildFetch(t, sinceUid)); }

  async close(): Promise<void> {
    // Best effort; a hung server must not hold the Worker, so give LOGOUT two seconds.
    const logout = this.run((t) => `${t} LOGOUT\r\n`).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([logout, new Promise((r) => { timer = setTimeout(r, 2000); })]);
    clearTimeout(timer);
    try { await this.socket.close(); } catch { /* already closed */ }
  }
}

async function withSession<T>(open: ImapConnector, mb: Mailbox, password: string, fn: (s: ImapSession) => Promise<T>): Promise<T> {
  const implicit = mb.imap_port === 993;
  const session = new ImapSession(open(mb.imap_host, mb.imap_port, implicit ? "on" : "starttls"));
  try {
    await session.greeting();
    if (!implicit) await session.startTls();
    await session.login(mb.username, password);
    return await fn(session);
  } catch (e) {
    throw new Error(redact(e instanceof Error ? e.message : String(e), password));
  } finally {
    await session.close();
  }
}

export const fetchImapOver = (open: ImapConnector, mb: Mailbox, password: string, sinceUid: number | null) =>
  withSession(open, mb, password, async (s) => {
    const baseline = await s.select();
    if (sinceUid === null) return { ...baseline, messages: [] };
    const messages = newMessages(parseImapFetch(await s.fetch(sinceUid)), sinceUid);
    return { ...baseline, messages };
  });

export const probeImapOver = (open: ImapConnector, mb: Mailbox, password: string) =>
  withSession(open, mb, password, async (s) => ({ uidValidity: (await s.select()).uidValidity }));

const realConnect: ImapConnector = (host, port, secure) =>
  connect({ hostname: host, port }, { secureTransport: secure, allowHalfOpen: false }) as unknown as ImapSocket;

/** The real reader. With sinceUid null it returns only the baseline and fetches no messages. */
export const fetchImap: ImapFetch = (mb, password, sinceUid) => fetchImapOver(realConnect, mb, password, sinceUid);
/** Logs in and selects INBOX, fetching nothing. */
export const fetchImapProbe: ImapProbe = (mb, password) => probeImapOver(realConnect, mb, password);
