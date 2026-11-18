import { useState } from "react";
import { api, ApiError } from "../../api";
import { Card, Field, Row } from "../../components/SettingsPage";
import { Pill, Toggle } from "../../components/settingsBits";
import { fieldErrors } from "../../campaignView";
import { mailboxTitle, secretCommand, secretName, syncLine, syncSummaryLine, testResultLines, warmupLine } from "../../mailboxView";
import type { Mailbox } from "../../types";

interface Form { enabled: boolean; smtp_host: string; smtp_port: string; imap_host: string; imap_port: string; username: string; from_name: string; from_email: string }
interface Result { bad: boolean; lines: string[] }
type Action = "save" | "test" | "send" | "sync" | "warmup";

const toForm = (mb: Mailbox): Form => ({
  enabled: mb.enabled === 1, smtp_host: mb.smtp_host, smtp_port: String(mb.smtp_port), imap_host: mb.imap_host, imap_port: String(mb.imap_port),
  username: mb.username, from_name: mb.from_name, from_email: mb.from_email,
});
const parsePort = (s: string) => (/^\d+$/.test(s.trim()) && Number(s) >= 1 && Number(s) <= 65535 ? Number(s) : null);
const reason = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** One mailbox: its settings, whether its password secret exists, the four actions and their results (in a polite live region). */
export default function MailboxCard({ mailbox, onChange }: { mailbox: Mailbox; onChange: (mb: Mailbox) => void }) {
  const [form, setForm] = useState<Form>(() => toForm(mailbox));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Action | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const key = mailbox.key;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setForm((f) => ({ ...f, [k]: v })); setErrs((e) => ({ ...e, [k]: "" })); };
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(mailbox));
  const started = mailbox.warmup_started_at !== null;
  const now = new Date();
  const id = (f: string) => `mb-${key}-${f}`;
  const say = (bad: boolean, ...lines: string[]) => setResult({ bad, lines });

  async function run(action: Action, work: () => Promise<void>) {
    setBusy(action); setResult(null);
    try { await work(); } catch (e) { say(true, `Failed: ${reason(e, "request failed")}`); } finally { setBusy(null); }
  }

  const save = () => run("save", async () => {
    const next: Record<string, string> = {};
    const smtp = parsePort(form.smtp_port); const imap = parsePort(form.imap_port);
    if (smtp === null) next.smtp_port = "Enter a port from 1 to 65535.";
    if (imap === null) next.imap_port = "Enter a port from 1 to 65535.";
    setErrs(next);
    if (smtp === null || imap === null) { say(true, "Not saved: fix the highlighted fields."); return; }
    try {
      const saved = await api.put<Mailbox>(`/mailboxes/${key}`, {
        enabled: form.enabled, smtp_host: form.smtp_host.trim(), smtp_port: smtp, imap_host: form.imap_host.trim(), imap_port: imap,
        username: form.username.trim(), from_name: form.from_name.trim(), ...(form.from_email.trim() ? { from_email: form.from_email.trim() } : {}),
      });
      onChange(saved); setForm(toForm(saved)); say(false, "Saved.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) { setErrs(fieldErrors(e.fields)); say(true, "Not saved: fix the highlighted fields."); } else throw e;
    }
  });
  const test = () => run("test", async () => {
    const r = await api.post<Parameters<typeof testResultLines>[0]>(`/mailboxes/${key}/test`);
    say(!r.smtp.ok || !r.imap.ok, ...testResultLines(r));
  });
  const send = () => run("send", async () => {
    await api.post(`/mailboxes/${key}/test-send`);
    say(false, `Test message sent to ${mailbox.from_email}.`);
  });
  const sync = () => run("sync", async () => {
    const r = await api.post<Parameters<typeof syncSummaryLine>[0]>(`/mailboxes/${key}/sync`);
    say(!!r.error, syncSummaryLine(r));
    onChange((await api.get<{ mailboxes: Mailbox[] }>("/mailboxes")).mailboxes.find((m) => m.key === key) ?? mailbox);
  });
  const warmup = () => {
    if (!window.confirm("Start the 30-day warm-up clock now? It can't be restarted.")) return;
    void run("warmup", async () => { const mb = await api.post<Mailbox>(`/mailboxes/${key}/start-warmup`); onChange(mb); say(false, "Warm-up clock started."); });
  };

  const off = busy !== null;
  const noTest = off || dirty;
  return (
    <Card title={mailboxTitle(key)} sub={key === "outreach" ? "Sends the cold sequence and checks for replies." : "Your everyday mailbox. Replies here also stop a sequence."}
      action={<Toggle checked={form.enabled} onChange={(on) => set("enabled", on)} label={`${mailboxTitle(key)} enabled`} disabled={off}><span>Enabled</span></Toggle>}>
      <Row>
        <Field label="SMTP host" htmlFor={id("smtp_host")} error={errs.smtp_host}><input id={id("smtp_host")} value={form.smtp_host} autoComplete="off" onChange={(e) => set("smtp_host", e.target.value)} /></Field>
        <Field label="SMTP port" htmlFor={id("smtp_port")} error={errs.smtp_port}><input id={id("smtp_port")} inputMode="numeric" value={form.smtp_port} autoComplete="off" onChange={(e) => set("smtp_port", e.target.value)} /></Field>
      </Row>
      <Row>
        <Field label="IMAP host" htmlFor={id("imap_host")} error={errs.imap_host}><input id={id("imap_host")} value={form.imap_host} autoComplete="off" onChange={(e) => set("imap_host", e.target.value)} /></Field>
        <Field label="IMAP port" htmlFor={id("imap_port")} error={errs.imap_port}><input id={id("imap_port")} inputMode="numeric" value={form.imap_port} autoComplete="off" onChange={(e) => set("imap_port", e.target.value)} /></Field>
      </Row>
      <Field label="Username" htmlFor={id("username")} error={errs.username}><input id={id("username")} value={form.username} autoComplete="off" onChange={(e) => set("username", e.target.value)} /></Field>
      <Row>
        <Field label="From name" htmlFor={id("from_name")} error={errs.from_name}><input id={id("from_name")} value={form.from_name} autoComplete="off" onChange={(e) => set("from_name", e.target.value)} /></Field>
        <Field label="From email" htmlFor={id("from_email")} error={errs.from_email}><input id={id("from_email")} type="email" value={form.from_email} autoComplete="off" onChange={(e) => set("from_email", e.target.value)} /></Field>
      </Row>

      <div className="mb-secret">
        <Pill tone={mailbox.passwordSet ? "positive" : "warning"}>Password secret: {mailbox.passwordSet ? "set" : "missing"}</Pill>
        <p className="bx-muted">The password is never typed here. It lives in a Worker secret. To set or change it, run this and paste the password when asked:</p>
        <code className="mb-cmd" aria-label={`Command to set the ${secretName(key)} secret`}>{secretCommand(key)}</code>
      </div>

      <div className="mb-lines">
        <p>{warmupLine(mailbox, now)}</p>
        <p>{syncLine(mailbox, now)}</p>
      </div>

      <div className="mb-actions">
        <button type="button" className="btn primary" onClick={() => void save()} disabled={off || !dirty}>{busy === "save" ? "Saving…" : "Save"}</button>
        <button type="button" className="btn" onClick={() => void test()} disabled={noTest} aria-describedby={dirty ? id("hint") : undefined}>{busy === "test" ? "Testing…" : "Test connection"}</button>
        <button type="button" className="btn" onClick={() => void send()} disabled={noTest} aria-describedby={dirty ? id("hint") : undefined}>{busy === "send" ? "Sending…" : "Send test"}</button>
        <button type="button" className="btn" onClick={() => void sync()} disabled={noTest} aria-describedby={dirty ? id("hint") : undefined}>{busy === "sync" ? "Checking…" : "Check for replies now"}</button>
        {key === "outreach" && <button type="button" className="btn" onClick={warmup} disabled={off || started}>{started ? "Warm-up started" : busy === "warmup" ? "Starting…" : "Start warm-up clock"}</button>}
      </div>
      {dirty && <p className="bx-muted" id={id("hint")}>Save your changes first. The tests use the saved settings.</p>}
      <div className={`mb-result${result?.bad ? " bad" : ""}`} aria-live="polite" aria-atomic="true">
        {result?.lines.map((l, i) => <p key={i}>{l}</p>)}
      </div>
    </Card>
  );
}
