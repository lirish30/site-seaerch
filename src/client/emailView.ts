export type Purpose = "freelance";
export const PURPOSE_LABEL: Record<Purpose, string> = { freelance: "Freelance work" };

export interface Draft {
  id: string; business_id: string; subject: string; body: string; recipient_reason: string; edited: boolean; created_at: string;
  steering_note: string | null; purpose: Purpose; angle: string; include_footer: boolean; variant_group: string | null; variant_index: number; posting_id: string | null;
}

/** GET /api/leads/:id/draft-role. `cited` is the role the current draft names (`warning` set when that is no longer true); `next` is what a new draft would cite. */
export interface DraftRole {
  cited: { id: string; title: string | null; url: string | null; state: "open" | "unseen" | "closed"; warning: string | null } | null;
  next: { id: string; title: string; url: string; role_kind: string } | null;
}

export interface WorkSample { id: string; title: string; url: string; result_line: string; tags: string }

export interface SignatureData {
  name: string; title: string; email: string; phone: string; website: string;
  links: { label: string; url: string }[];
  image_url: string; image_link: string; image_width: number;
}
export const MAX_SIGNATURE_LINKS = 8;
export const emptySignature = (): SignatureData => ({ name: "", title: "", email: "", phone: "", website: "", links: [], image_url: "", image_link: "", image_width: 96 });

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Reads the stored signature JSON into editable form. Anything unreadable is an empty signature. */
export function readSignature(json: unknown): SignatureData {
  const base = emptySignature();
  if (typeof json !== "string" || !json.trim()) return base;
  let raw: any;
  try { raw = JSON.parse(json); } catch { return base; }
  if (!raw || typeof raw !== "object") return base;
  const width = Number(raw.image_width);
  return {
    name: text(raw.name), title: text(raw.title), email: text(raw.email), phone: text(raw.phone), website: text(raw.website),
    links: (Array.isArray(raw.links) ? raw.links : []).slice(0, MAX_SIGNATURE_LINKS).map((l: any) => ({ label: text(l?.label), url: text(l?.url) })),
    image_url: text(raw.image_url), image_link: text(raw.image_link),
    image_width: Number.isFinite(width) && width > 0 ? Math.min(300, Math.max(40, Math.round(width))) : base.image_width,
  };
}

export const isBlankSignature = (s: SignatureData) =>
  !s.name.trim() && !s.title.trim() && !s.email.trim() && !s.phone.trim() && !s.website.trim() && !s.image_url.trim() && !s.links.some((l) => l.url.trim() || l.label.trim());

/** What gets saved: "" for an empty signature (so the plain-text one is used), else the JSON. */
export const writeSignature = (s: SignatureData) => (isBlankSignature(s) ? "" : JSON.stringify(s));

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export const snippet = (s: string, max = 120) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
};

export const variantTitle = (v: { angle: string }, i: number) => v.angle.trim() || `Option ${i + 1}`;

export const TWEAK_BUTTONS: { key: "shorter" | "warmer" | "more_direct"; label: string }[] = [
  { key: "shorter", label: "Shorter" }, { key: "warmer", label: "Warmer" }, { key: "more_direct", label: "More direct" },
];

export const mailtoHref = (to: string, subject: string, text: string) =>
  `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
