import type { CapturedPage, EvidenceDraft } from "../types";
import { base, isShell } from "./layout";

const pathOf = (u: string) => { try { return new URL(u).pathname; } catch { return u; } };

export function formEvidence(p: CapturedPage): EvidenceDraft[] {
  if (!p.desktop) return [];
  return p.desktop.forms.slice(0, 3).map((f) => {
    const req = f.fields.filter((x) => x.required).length;
    const extras = [f.hasCaptcha ? "it also has a CAPTCHA" : "", f.privacyNote ? "" : "no privacy reassurance near the button",
      /^(submit|send)$/i.test(f.submitText) ? `the button just says "${f.submitText}"` : ""].filter(Boolean);
    return { ...base(p), family: "form", device: "desktop", crop: { ...f.box, device: "desktop", pageIndex: p.index },
      data: { fields: f.fields.length, required: req },
      fact: `Form has ${f.fields.length} fields (${req} required): ${f.fields.map((x) => x.label || x.name || x.type).join(", ")}${extras.length ? `; ${extras.join("; ")}` : ""}` } as EvidenceDraft;
  });
}

export function flowEvidence(p: CapturedPage): EvidenceDraft[] {
  const f = p.flow;
  if (!f) return [];
  const host = (() => { try { return new URL(f.finalUrl).hostname; } catch { return f.finalUrl; } })();
  const fact = f.opensModal ? `Main button "${f.ctaText}" opens an on-page pop-up`
    : f.vendor ? `Main button "${f.ctaText}" sends visitors to ${f.vendor} (${host})${f.offDomain ? ", off this website" : ""}`
    : f.offDomain ? `Main button "${f.ctaText}" sends visitors to another website (${host})`
    : `Main button "${f.ctaText}" leads to ${pathOf(f.finalUrl)}${f.formFields ? ` with a ${f.formFields}-field form` : " with no form"}`;
  return [{ ...base(p), family: "flow", device: "desktop", data: { ...f }, fact }];
}

export function trustEvidence(p: CapturedPage): EvidenceDraft[] {
  const s = p.desktop;
  if (!s || isShell(s) || !(p.index === 0 || p.kind === "testimonials")) return [];
  const t = s.trust;
  const out: EvidenceDraft[] = [];
  const add = (fact: string) => out.push({ ...base(p), family: "trust", device: "desktop", fact });
  add(t.reviewWidget ? `Shows a ${t.reviewWidget}` : "No live review widget (Google, Trustpilot or Yelp) on this page");
  if (t.testimonialCount) add(`${t.testimonialCount} testimonials, ${t.attributedTestimonials} with a name attached`);
  add(t.badgeCount ? `${t.badgeCount} badge or credential images (licensed, award, association)` : "No badges or credentials shown");
  add(t.guaranteeText ? `Guarantee wording: "${t.guaranteeText}"` : "No guarantee or warranty wording found");
  if (t.yearsText) add(`Mentions experience: "${t.yearsText}"`);
  return out;
}
