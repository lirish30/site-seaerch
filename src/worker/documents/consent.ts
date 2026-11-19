/**
 * The ESIGN consent a client reads and ticks before typing a signature. The exact text shown is stored with each signature (with this version),
 * so bump ESIGN_VERSION on ANY change to the disclosure or the labels below.
 */
export const ESIGN_VERSION = 1;

/** Plain text, paragraphs separated by a blank line. Covers the five topics the US ESIGN Act expects. */
export const ESIGN_DISCLOSURE = [
  "Consent to electronic records and signatures. By ticking the box below and typing your name, you agree to review this document, sign it, and receive copies of it and related notices (such as invoices and receipts) as electronic records instead of on paper. Your electronic signature has the same legal effect as a handwritten one.",
  "Your right to a paper copy. You may ask for a paper copy of this document and of anything else sent to you electronically under it, at no charge, by replying by email to the message that delivered this link. We will mail it to the address you give us.",
  "How to withdraw your consent. You may decline to sign electronically at any time before you sign: close this page, and nothing is recorded as signed. If you would rather sign on paper, reply by email and we will arrange it. Once you have signed, the signature stands, and the signed document remains valid.",
  "What you need. To sign and keep this document you need a current web browser and an email address where you can receive messages and open the signed PDF we send you. If you cannot open it, tell us and we will send it another way.",
  "Typing your name is your signature. When you type your name in the signature box and press the sign button, you intend that typed name to be your legal signature on this document. We record the time, the network address and browser you signed from, and a fingerprint of the exact document you saw, and we keep that record with the signed copy.",
].join("\n\n");

/** The checkbox text for consent to do business electronically. */
export const CONSENT_LABEL = "I have read the disclosure above and I agree to use electronic records and signatures.";

/** The checkbox text for authority to sign for the business, without a business name. */
export const AUTHORITY_LABEL = "I am authorized to sign for the business named in this document.";

/** "I am authorized to sign for <business>". The business name is a prospect's text: the caller escapes it where it is shown. */
export const authorityLabel = (clientName: string): string => `I am authorized to sign for ${clientName}`;
