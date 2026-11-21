import { guestLinkBase } from "../booking/mail";

// The mail that tells a Care client their monthly report is ready (Plan 13): a fixed template, nothing of ours in it but the summary and the one link to the report page.

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The client's link to the report page: the client base, `/m/` and the token. Null when the base is not an https address (never workers.dev). */
export function reportLink(base: string | undefined, token: string): string | null {
  const b = guestLinkBase(base);
  return b ? `${b}/m/${token}` : null;
}

export interface ReportMail { subject: string; body: string }

/**
 * The same words for every client, a fixed template: the greeting, the summary, the link, the sign-off. It has no figure of its own (the numbers are on the report page behind the link) and
 * no address but that link. What a person typed (the contact's and the client's names, the summary) is shown as typed and the sender escapes it; the summary keeps its own line breaks.
 */
export function renderReportMail(o: { clientName: string; contactName: string; yourName: string; summary: string; link: string; period: string }): ReportMail {
  const first = oneLine(o.contactName).split(" ")[0].slice(0, 60);
  const client = oneLine(o.clientName).slice(0, 120);
  const body = [
    first ? `Hi ${first},` : "Hi,",
    `Here is the ${o.period} Care report${client ? ` for ${client}` : ""}.`,
    o.summary.trim().replace(/(\r?\n){3,}/g, "\n\n"),
    "You can read the whole report here:",
    o.link,
    "Reply to this email if you have a question.",
    ["Thanks,", oneLine(o.yourName)].filter(Boolean).join("\n"),
  ].join("\n\n");
  return { subject: `Your site's report for ${o.period}`.slice(0, 200), body };
}
