import { clientBase } from "../documents/mail";
import type { Env } from "../env";

// The mail that tells a client their strategy memo is ready (Plan 16): a fixed template. Nothing Claude wrote is in it, only the client's and the contact's names, the one link to the memo page and the sign-off.
// It makes no promise, names no price and no date: the plan is on the page behind the link.

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The client's link to the memo page: the client link base, `/y/` and the token. Null when the base is not an https address of our own (never workers.dev, never the cold-email host), the same check as the
 * Local SEO report's link, so the mail is never sent with a link that would not open or that would give the host away.
 */
export function strategyLink(env: Pick<Env, "CLIENT_LINK_BASE" | "OUTREACH_LINK_BASE">, token: string): string | null {
  const base = clientBase(env);
  return base ? `${base}/y/${token}` : null;
}

export interface StrategyMail { subject: string; body: string }

/** The same words for every client: the greeting, what the plan is, the link on its own line, one line about talking it through, the sign-off. Names are shown as typed and the sender escapes them. */
export function renderStrategyMail(o: { clientName: string; contactName: string; yourName: string; link: string }): StrategyMail {
  const first = oneLine(o.contactName).split(" ")[0].slice(0, 60);
  const client = oneLine(o.clientName).slice(0, 120);
  const body = [
    first ? `Hi ${first},` : "Hi,",
    "We put together a short plan for where your website and Google presence stand today and what we would do first. You can read it here:",
    o.link,
    "I am happy to talk it through whenever suits you.",
    ["Thanks,", oneLine(o.yourName)].filter(Boolean).join("\n"),
  ].join("\n\n");
  return { subject: `Your plan, ${client}`.slice(0, 200), body };
}
