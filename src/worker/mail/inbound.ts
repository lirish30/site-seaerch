import PostalMime from "postal-mime";

const TEXT_LIMIT = 20_000;

export interface InboundMessage {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string;
  subject: string;
  text: string;
  date: string | null;
  autoSubmitted: boolean;
  dsn: { status: string; recipient: string | null } | null;
}

export type InboundKind = "bounce_hard" | "bounce_soft" | "auto_reply" | "stop" | "reply";

const empty = (): InboundMessage => ({
  messageId: null, inReplyTo: null, references: [], from: "", subject: "", text: "",
  date: null, autoSubmitted: false, dsn: null,
});

/** Status and recipient from a message/delivery-status body (or a bounce that quotes one in its text). */
function readDsn(body: string): InboundMessage["dsn"] {
  const status = /^Status:\s*([245]\.\d{1,3}\.\d{1,3})\b/im.exec(body)?.[1];
  if (!status) return null;
  const recipient = /^Final-Recipient:\s*[^;\r\n]*;\s*(\S+)/im.exec(body)?.[1] ?? null;
  return { status, recipient: recipient ? recipient.toLowerCase() : null };
}

/** Parses one raw RFC 822 message. Never throws: anything unreadable comes back as empty fields. */
export async function parseInbound(raw: Uint8Array): Promise<InboundMessage> {
  try {
    const email = await PostalMime.parse(raw, { attachmentEncoding: "utf8" });
    // No header section at all means this was not a mail message (garbage, a truncated fetch).
    if (email.headers.length === 0) return empty();
    const header = (name: string) => email.headers.find((h) => h.key === name)?.value.trim() ?? null;

    const auto = header("auto-submitted");
    let dsn: InboundMessage["dsn"] = null;
    for (const a of email.attachments) {
      if (a.mimeType === "message/delivery-status" && typeof a.content === "string") {
        dsn = readDsn(a.content);
        if (dsn) break;
      }
    }

    return {
      messageId: email.messageId?.trim() || null,
      inReplyTo: email.inReplyTo?.trim() || null,
      references: (email.references ?? "").split(/\s+/).filter(Boolean),
      from: (email.from?.address ?? email.from?.group?.[0]?.address ?? "").trim().toLowerCase(),
      subject: (email.subject ?? "").trim(),
      text: (email.text ?? "").slice(0, TEXT_LIMIT),
      date: email.date ?? null,
      autoSubmitted: auto !== null && auto.toLowerCase() !== "no",
      dsn,
    };
  } catch {
    return empty();
  }
}

const WROTE = /^On\b[^\n]*(?:\n[^\n]*)?\bwrote:[ \t]*$/m;
const ORIGINAL = /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}[ \t]*$/im;

/** Removes quoted lines and everything from an "On ... wrote:" or "Original Message" line onward. */
export function stripQuoted(text: string): string {
  let t = text.replace(/\r\n?/g, "\n");
  for (const re of [WROTE, ORIGINAL]) {
    const at = re.exec(t)?.index;
    if (at !== undefined) t = t.slice(0, at);
  }
  return t.split("\n").filter((l) => !/^\s*>/.test(l)).join("\n").trim();
}

const STOP = /^(please\s+)?(stop|unsubscribe|no thanks|no thank you|remove me\b.*|(do not|don't|dont)\s+(contact|email)\b.*)[.! ]*$/i;
const AUTO_SUBJECT = /^\s*(automatic reply|out of office)/i;

/** Deterministic: a DSN decides first, then auto-replies, then an opt-out in the first line of the new text. */
export function classifyInbound(m: InboundMessage): InboundKind {
  if (m.dsn) {
    if (m.dsn.status.startsWith("5.")) return "bounce_hard";
    if (m.dsn.status.startsWith("4.")) return "bounce_soft";
    return "auto_reply"; // 2.x.x delivery notices are machine mail, never a person replying
  }
  if (m.autoSubmitted || AUTO_SUBJECT.test(m.subject)) return "auto_reply";
  const first = stripQuoted(m.text).split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return STOP.test(first) ? "stop" : "reply";
}
