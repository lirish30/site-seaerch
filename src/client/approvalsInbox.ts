import type { IconName } from "./components/Icon";
import { canBulkApprove, type ApprovalItem } from "./approvalsView";

/**
 * The words and sorting for the Approvals page (Figma 58:3999 inbox, 58:4450 edit & approve). Pure, so the page only lays things out.
 * The kinds are the worker's registered approval handlers (src/worker/approvals/*.ts); a kind this file does not know lands in "Other".
 */

export type Bucket = "emails" | "invoices" | "documents" | "reports" | "videos" | "posts" | "work" | "other";

export const BUCKETS: { key: Bucket; label: string; icon: IconName }[] = [
  { key: "emails", label: "Emails", icon: "mail" },
  { key: "invoices", label: "Invoices", icon: "card" },
  { key: "documents", label: "Proposals and change orders", icon: "file-text" },
  { key: "reports", label: "Reports", icon: "trending" },
  { key: "videos", label: "Video audits", icon: "eye" },
  { key: "posts", label: "Social posts", icon: "image" },
  { key: "work", label: "Site work and notes", icon: "check" },
  { key: "other", label: "Other", icon: "inbox" },
];

const KIND_BUCKET: Record<string, Bucket> = {
  "email.send": "emails", "ladder.mail": "emails", "meeting.followup": "emails", "onboarding.welcome": "emails", "onboarding.nudge": "emails",
  "invoice.send": "invoices", "invoice.reminder": "invoices", "invoice.pause_notice": "invoices", "subscription.start": "invoices", "subscription.term_notice": "invoices",
  "proposal.send": "documents", "change_order.send": "documents", "change_order.draft": "documents",
  "care.report": "reports", "seo.report": "reports", "strategy.memo": "reports",
  "video.publish": "videos",
  "studio.post": "posts",
  "sop.review": "work", "care.updates": "work", "lead.note": "work",
};

export const bucketOf = (kind: string): Bucket => KIND_BUCKET[kind] ?? "other";
export const bucketInfo = (b: Bucket) => BUCKETS.find((x) => x.key === b) ?? BUCKETS[BUCKETS.length - 1];
export const isBucket = (s: string | null): s is Bucket => !!s && BUCKETS.some((b) => b.key === s);

const KIND_NAME: Record<string, string> = {
  "email.send": "Email", "ladder.mail": "Client letter", "meeting.followup": "Meeting follow-up", "onboarding.welcome": "Onboarding welcome", "onboarding.nudge": "Onboarding reminder",
  "invoice.send": "Invoice", "invoice.reminder": "Payment reminder", "invoice.pause_notice": "Pause notice", "subscription.start": "Subscription link", "subscription.term_notice": "Term notice",
  "proposal.send": "Proposal", "change_order.send": "Change order", "change_order.draft": "Change order draft",
  "care.report": "Monthly report", "seo.report": "Local SEO report", "strategy.memo": "Strategy memo",
  "video.publish": "Video audit", "studio.post": "Social post", "sop.review": "Claude's step", "care.updates": "Site updates", "lead.note": "Lead note",
};

/** A short plain name for a kind ("Payment reminder"), falling back to the worker's label for a kind this file does not know. */
export const kindName = (kind: string, label?: string): string => KIND_NAME[kind] ?? label ?? kind;

export interface BucketGroup { key: Bucket; label: string; items: ApprovalItem[]; bulk: ApprovalItem[] }

/**
 * The inbox's groups: one per bucket, items oldest first (newest first when asked), and the group holding the oldest item first.
 * `bulk` is the part of a group Approve all may carry (canBulkApprove); the rest opens one by one.
 */
export function groupByBucket(items: ApprovalItem[], order: "oldest" | "newest" = "oldest"): BucketGroup[] {
  const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (order === "newest") sorted.reverse();
  const groups = new Map<Bucket, BucketGroup>();
  for (const it of sorted) {
    const key = bucketOf(it.kind);
    let g = groups.get(key);
    if (!g) { g = { key, label: bucketInfo(key).label, items: [], bulk: [] }; groups.set(key, g); }
    g.items.push(it);
    if (canBulkApprove(it.kind)) g.bulk.push(it);
  }
  return [...groups.values()];
}

/** How many wait in each bucket, in BUCKETS order, leaving out the empty ones. */
export function bucketCounts(items: Pick<ApprovalItem, "kind">[]): { key: Bucket; label: string; count: number }[] {
  const n = new Map<Bucket, number>();
  for (const it of items) n.set(bucketOf(it.kind), (n.get(bucketOf(it.kind)) ?? 0) + 1);
  return BUCKETS.filter((b) => n.has(b.key)).map((b) => ({ key: b.key, label: b.label, count: n.get(b.key)! }));
}

/** What the approve button says for a kind: what will actually happen when it is pressed. */
export function approveVerb(kind: string): string {
  switch (bucketOf(kind)) {
    case "emails": case "invoices": case "reports": return "Approve and send";
    case "documents": return kind === "change_order.draft" ? "Approve and make the draft" : "Approve and send";
    case "videos": return "Approve and publish";
    case "posts": return "Approve the post";
    default:
      if (kind === "care.updates") return "Approve and queue the updates";
      if (kind === "lead.note") return "Approve and save the note";
      if (kind === "sop.review") return "Approve the step";
      return "Approve";
  }
}

/** Why a kind has no Approve all (canBulkApprove is false for it): one plain sentence for the edit page. */
export function oneByOneReason(kind: string): string {
  switch (kind) {
    case "video.publish": return "A video goes public only after you have watched it.";
    case "proposal.send": return "Your approval is also your signature on the proposal, so read it first.";
    case "onboarding.welcome": return "The welcome asks you to add a video link first.";
    case "sop.review": return "Claude's step is marked done only after you look at the work.";
    case "change_order.send": return "A change order is checked against the contract before a client sees it.";
    case "invoice.send": case "subscription.start": return "This asks a client for money, so check the amount first.";
    case "care.updates": return "These update live sites, so check the list first.";
    case "care.report": case "seo.report": return "The report carries free text to a client, so read who wrote it.";
    default: return "";
  }
}

/** "Today 7:42 AM" reads as just "7:42 AM"; then "Yesterday", a weekday inside the last week, else "Nov 13". */
export function shortWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Splits a preview into its header lines ("To: …", "Subject: …") and the text under them. An email preview starts with From/To/Subject
 * lines and a blank line; other previews are plain text, so they come back with no facts.
 */
export function previewParts(preview: string): { facts: { label: string; value: string }[]; text: string } {
  const lines = preview.split("\n");
  const facts: { label: string; value: string }[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^(From|To|Subject|Video|Cc):\s?(.*)$/.exec(lines[i]);
    if (!m) break;
    facts.push({ label: m[1], value: m[2] });
  }
  if (facts.length === 0) return { facts, text: preview.trim() };
  return { facts, text: lines.slice(i).join("\n").trim() };
}

/** The one grey line under a row's title: who an email goes to and its subject, else the first line of the preview. */
export function rowLine(preview: string): string {
  const { facts, text } = previewParts(preview);
  const to = facts.find((f) => f.label === "To")?.value;
  const subject = facts.find((f) => f.label === "Subject")?.value;
  if (to || subject) return [to && `To ${to}`, subject && `“${subject}”`].filter(Boolean).join(" · ");
  return text.replace(/\s+/g, " ").trim();
}

// ---- Editing: the kinds whose payload carries words you can change today. Everything else carries only an id (the record is read again at approval).

export interface EditField { key: string; label: string; type: "line" | "text" | "number"; max?: number; optional?: boolean; hint?: string }

export const EDIT_FIELDS: Record<string, EditField[]> = {
  "email.send": [
    { key: "to", label: "To", type: "line", max: 254 },
    { key: "subject", label: "Subject", type: "line", max: 200 },
    { key: "body", label: "Message", type: "text", hint: "Your signature and the footer are added when it sends." },
  ],
  "lead.note": [{ key: "text", label: "Note", type: "text", max: 2000 }],
  "ladder.mail": [{ key: "personalLine", label: "Your personal line", type: "text", max: 600, optional: true, hint: "Added to the fixed mail. Leave it empty to send the mail as it is." }],
  "change_order.draft": [
    { key: "title", label: "Title", type: "line", max: 120 },
    { key: "summary", label: "What the work is", type: "text", max: 1500 },
    { key: "reason", label: "Why it is extra", type: "text", max: 600 },
    { key: "hours", label: "Hours", type: "number", hint: "In steps of 0.25, up to 40." },
  ],
};

export const editFields = (kind: string): EditField[] => EDIT_FIELDS[kind] ?? [];

const asObj = (p: unknown): Record<string, unknown> => (p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {});

/** The edit boxes' starting text, read from the payload. */
export function fieldValues(kind: string, payload: unknown): Record<string, string> {
  const o = asObj(payload);
  return Object.fromEntries(editFields(kind).map((f) => [f.key, o[f.key] === undefined || o[f.key] === null ? "" : String(o[f.key])]));
}

/**
 * The payload to send after editing: the original with the edited fields put back (numbers as numbers, an empty optional field left out).
 * `changed` is false when nothing differs, so the page approves without sending a payload, exactly as an untouched approve does.
 */
export function applyEdits(kind: string, payload: unknown, values: Record<string, string>):
  { ok: true; value: unknown; changed: boolean } | { ok: false; error: string } {
  const next: Record<string, unknown> = { ...asObj(payload) };
  for (const f of editFields(kind)) {
    const raw = values[f.key] ?? "";
    if (f.type === "number") {
      const n = Number(raw);
      if (!raw.trim() || !Number.isFinite(n)) return { ok: false, error: `${f.label} needs a number.` };
      next[f.key] = n;
      continue;
    }
    if (f.max !== undefined && raw.length > f.max) return { ok: false, error: `${f.label} is at most ${f.max} characters.` };
    if (!raw.trim()) {
      if (!f.optional) return { ok: false, error: `${f.label} can't be empty.` };
      delete next[f.key];
      continue;
    }
    next[f.key] = raw;
  }
  return { ok: true, value: next, changed: JSON.stringify(next) !== JSON.stringify(asObj(payload)) };
}

/** The video link an email carries (Email 1 of a video campaign), when it has one. */
export function heroOf(payload: unknown): { href: string; alt: string } | null {
  const h = asObj(asObj(payload).heroImage);
  return typeof h.href === "string" && h.href ? { href: h.href, alt: typeof h.alt === "string" ? h.alt : "" } : null;
}

/** Which ids are next and before this one in the list shown, for the pager on the edit page. */
export function neighbours(ids: string[], id: string): { index: number; prev: string | null; next: string | null } {
  const index = ids.indexOf(id);
  if (index < 0) return { index, prev: null, next: null };
  return { index, prev: index > 0 ? ids[index - 1] : null, next: index < ids.length - 1 ? ids[index + 1] : null };
}
