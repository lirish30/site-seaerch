import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { MAILBOX_KEYS, getMailbox, mailboxPassword, saveMailbox, startWarmup } from "../db/mailboxes";
import { lookupMailDns } from "../dns";
import { getMailDeps } from "../mail/deps";
import type { Mailbox, MailboxKey } from "../mail/types";

const Port = z.number().int().min(1).max(65535);
const Host = z.string().trim().max(253);
const Text = z.string().trim().max(200);

// strict(): a password (or any unknown field) is rejected, never stored.
const PutMailbox = z.object({
  enabled: z.boolean().optional(),
  smtp_host: Host.optional(), smtp_port: Port.optional(),
  imap_host: Host.optional(), imap_port: Port.optional(),
  username: Text.optional(), from_email: z.email().max(254).optional(), from_name: Text.optional(),
}).strict();

const view = (env: Env, mb: Mailbox) => ({ ...mb, passwordSet: mailboxPassword(env, mb.key) !== null });
const message = (e: unknown, secret: string) => {
  const text = e instanceof Error ? e.message : String(e);
  return secret ? text.split(secret).join("***") : text;
};
const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
const configured = (mb: Mailbox) => !!(mb.smtp_host && mb.username && mb.from_email.includes("@"));

export const mailboxRoutes = new Hono<{ Bindings: Env }>();

mailboxRoutes.get("/", async (c) => {
  const boxes = await Promise.all(MAILBOX_KEYS.map((k) => getMailbox(c.env.DB, k)));
  return c.json({ mailboxes: boxes.map((mb) => view(c.env, mb)) });
});

mailboxRoutes.use("/:key/*", async (c, next) => {
  if (!(MAILBOX_KEYS as readonly string[]).includes(c.req.param("key"))) return c.json({ error: "mailbox not found" }, 404);
  await next();
});

mailboxRoutes.put("/:key", async (c) => {
  const key = c.req.param("key") as MailboxKey;
  const parsed = PutMailbox.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body", fields: z.flattenError(parsed.error).fieldErrors }, 400);
  const { enabled, ...rest } = parsed.data;
  const saved = await saveMailbox(c.env.DB, key, { ...rest, ...(enabled === undefined ? {} : { enabled: enabled ? 1 : 0 }) });
  return c.json(view(c.env, saved));
});

/** A short message to the mailbox's own address; never to anyone else. */
async function sendToSelf(mb: Mailbox, password: string, subject: string): Promise<void> {
  await getMailDeps().smtp(mb, password, {
    from: { email: mb.from_email, name: mb.from_name },
    to: mb.from_email,
    subject,
    text: "This is a test message from your Siteline mailbox settings. Nothing else was sent.",
    html: "<p>This is a test message from your Siteline mailbox settings. Nothing else was sent.</p>",
    messageId: `<${crypto.randomUUID()}@${domainOf(mb.from_email)}>`,
  });
}

mailboxRoutes.post("/:key/test", async (c) => {
  const key = c.req.param("key") as MailboxKey;
  const mb = await getMailbox(c.env.DB, key);
  const password = mailboxPassword(c.env, key);
  if (!password || !configured(mb)) {
    const error = !password ? "password secret is not set" : "mailbox is not configured";
    return c.json({ smtp: { ok: false, error }, imap: { ok: false, error }, spf: null });
  }
  const deps = getMailDeps();
  const [smtp, imap, mail] = await Promise.all([
    sendToSelf(mb, password, "Siteline SMTP connection test")
      .then(() => ({ ok: true as const }), (e) => ({ ok: false as const, error: message(e, password) })),
    deps.imapProbe(mb, password)
      .then(() => ({ ok: true as const }), (e) => ({ ok: false as const, error: message(e, password) })),
    lookupMailDns(domainOf(mb.from_email), deps.fetch),
  ]);
  return c.json({ smtp, imap, spf: mail.hasSpf });
});

mailboxRoutes.post("/:key/test-send", async (c) => {
  const key = c.req.param("key") as MailboxKey;
  const mb = await getMailbox(c.env.DB, key);
  const password = mailboxPassword(c.env, key);
  if (!password) return c.json({ error: "password secret is not set" }, 400);
  if (!configured(mb)) return c.json({ error: "mailbox is not configured" }, 400);
  try {
    await sendToSelf(mb, password, "Siteline test message");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: message(e, password) }, 502);
  }
});

mailboxRoutes.post("/:key/start-warmup", async (c) => {
  const key = c.req.param("key") as MailboxKey;
  if (!(await startWarmup(c.env.DB, key, getMailDeps().now().toISOString()))) return c.json({ error: "warmup already started" }, 409);
  return c.json(view(c.env, await getMailbox(c.env.DB, key)));
});
