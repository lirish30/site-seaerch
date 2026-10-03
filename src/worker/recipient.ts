import type { Contact } from "./types";

const GENERIC_ORDER = ["owner", "info", "contact", "office"];
const FREE_MAIL = /@(gmail|yahoo|hotmail|outlook|aol|icloud|live|msn|comcast|att)\./i;
const LEADER_ROLE = /owner|founder|president|manager|principal|director|office/i;

function emailRank(e: Contact, domain: string | null): number {
  const [local, host] = e.value.toLowerCase().split("@");
  const own = domain !== null && (host === domain || host.endsWith(`.${domain}`));
  if (own && e.person_name) return e.role && LEADER_ROLE.test(e.role) ? 0 : 1;
  if (own) {
    const i = GENERIC_ORDER.indexOf(local);
    return 10 + (i === -1 ? GENERIC_ORDER.length : i);
  }
  if (FREE_MAIL.test(e.value)) return 30;
  return 40;
}

export function pickRecipient(contacts: Contact[], siteDomain: string | null) {
  const emails = contacts
    .filter((c) => c.type === "email")
    .sort((a, b) => emailRank(a, siteDomain) - emailRank(b, siteDomain) || b.confidence - a.confidence);
  const form = contacts.find((c) => c.type === "form") ?? null;
  const phone = contacts.find((c) => c.type === "phone") ?? null;

  if (emails.length) {
    const e = emails[0];
    const reason = e.person_name
      ? `${e.person_name}${e.role ? ` (${e.role})` : ""} listed on ${e.source_url ?? "their site"}`
      : `Best inbox found on ${e.source_url ?? "their site"}`;
    return { contact: e, emailContact: e, reason, ranked: emails };
  }
  if (form) return { contact: form, emailContact: null, reason: `No email found. Use the contact form at ${form.value}`, ranked: [] };
  if (phone) return { contact: phone, emailContact: null, reason: `No email or form found. Call ${phone.value}`, ranked: [] };
  return { contact: null, emailContact: null, reason: "No contact details found", ranked: [] };
}
