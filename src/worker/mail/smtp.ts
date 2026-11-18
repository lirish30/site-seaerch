import { WorkerMailer } from "worker-mailer";
import type { SmtpSend } from "./types";

/** Sends one message over SMTP: implicit TLS on 465, STARTTLS on any other port. Throws with the server's reply on failure. */
export const sendSmtp: SmtpSend = async (mb, password, msg) => {
  const headers: Record<string, string> = {
    ...msg.headers,
    "Message-ID": msg.messageId,
    "List-Unsubscribe": `<mailto:${mb.from_email}?subject=stop>`,
  };
  if (msg.inReplyTo) headers["In-Reply-To"] = msg.inReplyTo;
  if (msg.references?.length) headers["References"] = msg.references.join(" ");
  await WorkerMailer.send(
    {
      host: mb.smtp_host, port: mb.smtp_port,
      secure: mb.smtp_port === 465, startTls: mb.smtp_port !== 465,
      credentials: { username: mb.username, password },
      authType: ["plain", "login"],
    },
    { from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, headers },
  );
};
