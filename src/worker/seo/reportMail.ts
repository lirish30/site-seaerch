import { clientBase } from "../documents/mail";
import type { Env } from "../env";

// The mail that tells a Local SEO client their monthly report is ready (Plan 14): a fixed template, nothing of ours in it but Claude's summary and the one link to the report page.
// It holds no figure, no search term and no content title of its own: those are on the page behind the link.

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The client's link to the report page: the client link base, `/l/` and the token. Null when the base is not an https address of our own (never workers.dev, never the cold-email host), so the
 * mail is never sent with a link that would not open or that would give the host away.
 */
export function seoReportLink(env: Pick<Env, "CLIENT_LINK_BASE" | "OUTREACH_LINK_BASE">, token: string): string | null {
  const base = clientBase(env);
  return base ? `${base}/l/${token}` : null;
}

export interface SeoReportMail { subject: string; body: string }

/**
 * The same words for every client, a fixed template: the greeting, the summary, the link, the sign-off. What a person typed (the contact's and the client's names, the summary) is shown as typed
 * and the sender escapes it; the summary keeps its own line breaks.
 */
export function renderSeoReportMail(o: { clientName: string; contactName: string; yourName: string; summary: string; link: string; period: string }): SeoReportMail {
  const first = oneLine(o.contactName).split(" ")[0].slice(0, 60);
  const client = oneLine(o.clientName).slice(0, 120);
  const body = [
    first ? `Hi ${first},` : "Hi,",
    `Here is the ${o.period} Local SEO report${client ? ` for ${client}` : ""}.`,
    o.summary.trim().replace(/(\r?\n){3,}/g, "\n\n"),
    "You can read the whole report here:",
    o.link,
    "Reply to this email if you have a question.",
    ["Thanks,", oneLine(o.yourName)].filter(Boolean).join("\n"),
  ].join("\n\n");
  return { subject: `Your local search report for ${o.period}`.slice(0, 200), body };
}
