import { connect } from "cloudflare:sockets";
import type { ImapFetch, ImapFetchResult, ImapProbe, Mailbox } from "./types";

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
/** Sizes for an explicit UID range. Never `n:*`, which always returns the newest message even when nothing is new. */
export const buildFetchSizes = (tag: string, from: number, to: number): string => `${tag} UID FETCH ${from}:${to} (UID RFC822.SIZE)\r\n`;
export const buildFetchBody = (tag: string, uid: number): string => `${tag} UID FETCH ${uid} (UID BODY.PEEK[])\r\n`;

/** Messages examined per call. */
export const WINDOW = 25;
/** Messages larger than this are never downloaded. */
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
/** Most body bytes returned by one call; the rest waits for the next call. */
export const BATCH_BYTES = 16 * 1024 * 1024;

/** The UID range to examine next, or null when nothing is new (no FETCH needed at all). */
export function planWindow(sinceUid: number, uidNext: number, window = WINDOW): { from: number; to: number } | null {
  if (uidNext - 1 <= sinceUid) return null;
  return { from: sinceUid + 1, to: Math.min(sinceUid + window, uidNext - 1) };
}

/**
 * Decides which messages of a window to download. Oversized ones are skipped (and reported), and the
 * batch stops early once `budget` bytes are planned, so `highestUid` is the last UID fully accounted for.
 */
export function planBodies(
  sizes: { uid: number; size: number }[], windowEnd: number, maxMessage = MAX_MESSAGE_BYTES, budget = BATCH_BYTES,
): { fetch: number[]; skipped: { uid: number; size: number }[]; highestUid: number } {
  const fetch: number[] = [];
  const skipped: { uid: number; size: number }[] = [];
  let planned = 0;
  for (const m of [...sizes].sort((a, b) => a.uid - b.uid)) {
    if (m.size > maxMessage) { skipped.push(m); continue; }
    if (fetch.length > 0 && planned + m.size > budget) return { fetch, skipped, highestUid: m.uid - 1 };
    fetch.push(m.uid);
    planned += m.size;
  }
  return { fetch, skipped, highestUid: windowEnd };
}

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

interface FetchEntry { uid: number | null; size: number | null; raw: Uint8Array | null }

/** Parses every untagged `* n FETCH (...)` in a reply. Truncated input yields the entries that were complete. */
function parseFetchEntries(bytes: Uint8Array): FetchEntry[] {
  const out: FetchEntry[] = [];
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
      let size: number | null = null;
      let raw: Uint8Array | null = null;
      for (c.skipSpaces(); c.peek() !== 41; c.skipSpaces()) {
        const before = c.p;
        const name = c.atom().toUpperCase();
        c.skipSpaces();
        const v = c.value();
        if (c.p === before) throw new RangeError("malformed FETCH response");
        if (name === "UID" && v) uid = Number(dec.decode(v));
        else if (name === "RFC822.SIZE" && v) size = Number(dec.decode(v));
        else if ((name.startsWith("BODY[") || name === "RFC822") && v) raw = v;
      }
      c.p++; // closing paren
      c.toLineEnd();
      out.push({ uid: Number.isInteger(uid) ? uid : null, size: Number.isInteger(size) ? size : null, raw });
    }
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
  }
  return out;
}

/** Messages (UID plus body) from a `UID FETCH ... BODY.PEEK[]` reply, in server order. Entries lacking either are dropped. */
export function parseImapFetch(bytes: Uint8Array): { uid: number; raw: Uint8Array }[] {
  return parseFetchEntries(bytes).flatMap((e) => (e.uid !== null && e.raw ? [{ uid: e.uid, raw: e.raw }] : []));
}

/** UID and size pairs from a `UID FETCH ... (UID RFC822.SIZE)` reply. */
export function parseImapSizes(bytes: Uint8Array): { uid: number; size: number }[] {
  return parseFetchEntries(bytes).flatMap((e) => (e.uid !== null && e.size !== null ? [{ uid: e.uid, size: e.size }] : []));
}

// ---------- session over a socket-like ----------

export interface ImapSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  startTls?(): ImapSocket;
  close(): Promise<void> | void;
}
export type ImapConnector = (host: string, port: number, secure: "on" | "starttls") => ImapSocket;

export interface ImapLimits {
  /** Longest wait for the next bytes from the server. */
  readTimeoutMs: number;
  /** Longest a whole session may last. */
  totalTimeoutMs: number;
  /** Largest single command response held in memory. */
  maxResponseBytes: number;
  /** Longest LOGOUT and socket close may take during cleanup. */
  closeTimeoutMs: number;
}
const DEFAULT_LIMITS: ImapLimits = { readTimeoutMs: 20_000, totalTimeoutMs: 90_000, maxResponseBytes: 8 * 1024 * 1024, closeTimeoutMs: 2000 };

const concat = (parts: Uint8Array[], total: number): Uint8Array => {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** Resolves when `p` settles or after `ms`, whichever is first, and never rejects. */
async function within(work: () => Promise<unknown> | unknown, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = (async () => { try { await work(); } catch { /* best effort */ } })();
  await Promise.race([run, new Promise((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
}

class ImapSession {
  // Received bytes, kept as a list and joined only when a complete response may have arrived.
  private chunks: Uint8Array[] = [];
  private size = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private tagN = 0;
  private readonly deadline: number;

  constructor(private socket: ImapSocket, private readonly limits: ImapLimits = DEFAULT_LIMITS) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.deadline = Date.now() + limits.totalTimeoutMs;
  }

  private async readChunk(): Promise<void> {
    const ms = Math.min(this.limits.readTimeoutMs, this.deadline - Date.now());
    if (ms <= 0) throw new Error("IMAP session timed out");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("IMAP server stopped responding")), ms); });
    try {
      const { value, done } = await Promise.race([this.reader.read(), timeout]);
      if (done) throw new Error("IMAP connection closed unexpectedly");
      if (this.size + value.length > this.limits.maxResponseBytes) throw new Error("IMAP response too large");
      this.chunks.push(value);
      this.size += value.length;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Everything received so far as one buffer (the list collapses to it). */
  private joined(): Uint8Array {
    const all = concat(this.chunks, this.size);
    this.chunks = this.size ? [all] : [];
    return all;
  }

  private consume(n: number): void {
    const rest = this.joined().slice(n);
    this.chunks = rest.length ? [rest] : [];
    this.size = rest.length;
  }

  /** Cheap check on the last bytes only: does the data end with a line that starts with `tag `? */
  private endsWithTag(tag: string): boolean {
    let need = 4096;
    const tail: Uint8Array[] = [];
    for (let i = this.chunks.length - 1; i >= 0 && need > 0; i--) { tail.unshift(this.chunks[i]); need -= this.chunks[i].length; }
    const t = concat(tail, tail.reduce((n, c) => n + c.length, 0));
    if (t.length < 2 || t[t.length - 2] !== 13 || t[t.length - 1] !== 10) return false;
    let start = t.length - 2;
    while (start > 0 && !(t[start - 1] === 10 && start >= 2 && t[start - 2] === 13)) start--;
    return ascii(t, start, t.length).startsWith(`${tag} `);
  }

  async greeting(): Promise<void> {
    let eol: number;
    while ((eol = indexOfCrlf(this.joined(), 0)) < 0) await this.readChunk();
    const line = ascii(this.joined(), 0, eol);
    this.consume(eol + 2);
    if (!/^\* (OK|PREAUTH)\b/i.test(line)) throw new Error(`unexpected IMAP greeting: ${line.slice(0, 120)}`);
  }

  /** Sends one command and returns the untagged data that preceded its completion. Throws on NO/BAD. */
  async run(build: (tag: string) => string): Promise<Uint8Array> {
    const tag = `A${++this.tagN}`;
    const command = build(tag);
    await this.writer.write(enc.encode(command));
    for (;;) {
      const res = this.endsWithTag(tag) ? scanResponse(this.joined(), tag) : null;
      if (res) {
        this.consume(res.end);
        if (res.status !== "OK") throw new Error(`IMAP ${command.split(/[ \r]/)[1]} failed: ${res.text}`);
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
    this.chunks = [];
    this.size = 0;
  }

  async login(user: string, pass: string): Promise<void> { await this.run((t) => buildLogin(t, user, pass)); }
  async select(): Promise<{ uidValidity: number; uidNext: number }> { return parseSelect(dec.decode(await this.run(buildSelect))); }
  sizes(from: number, to: number): Promise<Uint8Array> { return this.run((t) => buildFetchSizes(t, from, to)); }
  body(uid: number): Promise<Uint8Array> { return this.run((t) => buildFetchBody(t, uid)); }

  /** Best effort. A hung server must not hold the Worker, so LOGOUT and the close each get a short cap. */
  async close(): Promise<void> {
    await within(() => this.run((t) => `${t} LOGOUT\r\n`), this.limits.closeTimeoutMs);
    await within(() => this.socket.close(), this.limits.closeTimeoutMs);
  }
}

async function withSession<T>(
  open: ImapConnector, mb: Mailbox, password: string, limits: Partial<ImapLimits> | undefined, fn: (s: ImapSession) => Promise<T>,
): Promise<T> {
  const implicit = mb.imap_port === 993;
  const session = new ImapSession(open(mb.imap_host, mb.imap_port, implicit ? "on" : "starttls"), { ...DEFAULT_LIMITS, ...limits });
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

/**
 * Reads at most WINDOW new messages after `sinceUid` using explicit UID ranges (never `n:*`).
 * Sizes come first; messages over MAX_MESSAGE_BYTES are skipped and reported, and the rest are
 * fetched one UID at a time so no single response outgrows the response cap.
 */
export const fetchImapOver = (open: ImapConnector, mb: Mailbox, password: string, sinceUid: number | null, limits?: Partial<ImapLimits>): Promise<ImapFetchResult> =>
  withSession(open, mb, password, limits, async (s) => {
    const baseline = await s.select();
    if (sinceUid === null) return { ...baseline, messages: [], skipped: [], highestUid: baseline.uidNext - 1 };
    const win = planWindow(sinceUid, baseline.uidNext);
    if (!win) return { ...baseline, messages: [], skipped: [], highestUid: sinceUid };
    const sizes = parseImapSizes(await s.sizes(win.from, win.to)).filter((m) => m.uid >= win.from && m.uid <= win.to);
    const plan = planBodies(sizes, win.to);
    const messages: { uid: number; raw: Uint8Array }[] = [];
    for (const uid of plan.fetch) {
      const got = parseImapFetch(await s.body(uid)).find((m) => m.uid === uid);
      if (got) messages.push(got);
    }
    return { ...baseline, messages: newMessages(messages, sinceUid), skipped: plan.skipped, highestUid: plan.highestUid };
  });

export const probeImapOver = (open: ImapConnector, mb: Mailbox, password: string, limits?: Partial<ImapLimits>) =>
  withSession(open, mb, password, limits, async (s) => ({ uidValidity: (await s.select()).uidValidity }));

const realConnect: ImapConnector = (host, port, secure) =>
  connect({ hostname: host, port }, { secureTransport: secure, allowHalfOpen: false }) as unknown as ImapSocket;

/** The real reader. With sinceUid null it returns only the baseline (highestUid = uidNext - 1) and fetches no messages. */
export const fetchImap: ImapFetch = (mb, password, sinceUid) => fetchImapOver(realConnect, mb, password, sinceUid);
/** Logs in and selects INBOX, fetching nothing. */
export const fetchImapProbe: ImapProbe = (mb, password) => probeImapOver(realConnect, mb, password);
