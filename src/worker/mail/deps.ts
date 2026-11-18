import type { Fetcher } from "../crawler/crawl";
import { sendSmtp } from "./smtp";
import type { ImapFetch, SmtpSend } from "./types";

export interface MailDeps { smtp: SmtpSend; imap: ImapFetch; now(): Date; fetch: Fetcher }

// Replaced by the real IMAP client in the sync task.
const imapNotImplemented: ImapFetch = async () => { throw new Error("IMAP not implemented yet"); };

const defaults = (): MailDeps => ({ smtp: sendSmtp, imap: imapNotImplemented, now: () => new Date(), fetch: (url, init) => fetch(url, init) });
let current: MailDeps = defaults();

export const getMailDeps = (): MailDeps => current;

/** Tests only: override some dependencies; null restores the real ones. */
export function setMailDeps(d: Partial<MailDeps> | null): void {
  current = d ? { ...defaults(), ...d } : defaults();
}
