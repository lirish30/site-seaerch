import { useEffect, useState } from "react";
import { api } from "../../api";
import { Chip } from "../../components/ds";
import Icon from "../../components/Icon";
import SettingsPage, { Card, Field } from "../../components/SettingsPage";
import { billingTermsProblem, offsetsText, parseOffsets, readBillingTerms, stripeRows, WEBHOOK_EVENTS, WEBHOOK_PATH, type BillingTerms, type StripeStatus } from "../../billingView";
import { useSettingsDoc } from "../../settingsData";

type NumKey = "netDays" | "pauseAfterDays" | "termNoticeDays";
/** A whole number typed in a box; NaN for blank or anything else, which `billingTermsProblem` refuses. */
const whole = (raw: string): number => (/^-?\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN);
/** One reminder day as words on the schedule strip. */
const dayWords = (d: number) => (d === 0 ? "On the due date" : d < 0 ? `${-d} ${d === -1 ? "day" : "days"} before` : `${d} ${d === 1 ? "day" : "days"} late`);

/** Settings > Billing: the four invoice numbers (saved as one JSON document the worker checks again), Stripe's status as booleans, and the events to switch on in Stripe. No key is ever shown. */
export default function Billing() {
  const doc = useSettingsDoc();
  const cfg = readBillingTerms(doc.value("billing_config"));
  // What is typed in the boxes (a key missing: show the saved or edited value). A save or a Discard empties the edits, and then the boxes follow the stored values again.
  const [typed, setTyped] = useState<Partial<Record<NumKey | "reminderOffsets", string>>>({});
  useEffect(() => { if (!doc.dirty) setTyped({}); }, [doc.dirty]);
  const text = (k: NumKey | "reminderOffsets"): string => typed[k] ?? (k === "reminderOffsets" ? offsetsText(cfg.reminderOffsets) : String(cfg[k]));

  const offsets = parseOffsets(text("reminderOffsets"));
  const terms: BillingTerms = {
    netDays: whole(text("netDays")), pauseAfterDays: whole(text("pauseAfterDays")), termNoticeDays: whole(text("termNoticeDays")), reminderOffsets: offsets ?? [],
  };
  const problem = offsets === null ? "Reminder days must be whole numbers separated by commas, like -3, 0, 3, 7" : billingTermsProblem(terms);
  const save = (patch: Partial<BillingTerms>) => doc.set("billing_config", JSON.stringify({ ...cfg, ...patch }));
  const num = (k: NumKey) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setTyped((t) => ({ ...t, [k]: e.target.value }));
    const n = whole(e.target.value);
    if (Number.isFinite(n)) save({ [k]: n });
  };

  const [stripe, setStripe] = useState<StripeStatus | null | false>(null);
  useEffect(() => { api.get<StripeStatus>("/billing/stripe-status").then(setStripe).catch(() => setStripe(false)); }, []);
  const rows = stripe ? stripeRows(stripe) : [];
  const missing = rows.filter((r) => !r.ok).length;
  const origin = typeof location === "undefined" ? "" : location.origin;

  return (
    <SettingsPage title="Billing" width={760} doc={doc} blocked={problem ?? undefined} sub="How long a client has to pay, when reminders go, and what is set up in Stripe."
      badge={stripe ? (stripe.mode === "live" ? <Chip tone="warning" dot>Stripe live</Chip> : stripe.mode ? <Chip tone="info" dot>Stripe test mode</Chip> : <Chip tone="outline" dot>Stripe not set up</Chip>) : undefined}>
      <div className="bx sox">
        <Card title="Invoice terms" sub="Saved as one document. The worker checks it again when you save and says which number is wrong.">
          <div className="sox-grid">
            <Field label="Days to pay an invoice" htmlFor="bl-net" help="1 to 60. The due date is this many days after an invoice is sent.">
              <input id="bl-net" className="sox-w" inputMode="numeric" value={text("netDays")} aria-invalid={Number.isNaN(terms.netDays)} onChange={num("netDays")} />
            </Field>
            <Field label="Term notice (days before the term ends)" htmlFor="bl-notice" help="7 to 90. The client is told a subscription's term is ending this many days ahead.">
              <input id="bl-notice" className="sox-w" inputMode="numeric" value={text("termNoticeDays")} aria-invalid={Number.isNaN(terms.termNoticeDays)} onChange={num("termNoticeDays")} />
            </Field>
            <Field label="Reminder days" htmlFor="bl-offsets" help="Days from the due date, 1 to 6 of them (-30 to 60). Negative is before it. Each reminder is a mail you approve.">
              <input id="bl-offsets" className="sox-w l" inputMode="text" autoComplete="off" value={text("reminderOffsets")} aria-invalid={offsets === null}
                onChange={(e) => { setTyped((t) => ({ ...t, reminderOffsets: e.target.value })); const o = parseOffsets(e.target.value); if (o) save({ reminderOffsets: o }); }} />
            </Field>
            <Field label="Pause work after (days past due)" htmlFor="bl-pause" help="7 to 60, and after the last reminder. Your tasks and Claude's for that client stop. The site and hosting are never touched.">
              <input id="bl-pause" className="sox-w" inputMode="numeric" value={text("pauseAfterDays")} aria-invalid={Number.isNaN(terms.pauseAfterDays)} onChange={num("pauseAfterDays")} />
            </Field>
          </div>
          {offsets && offsets.length > 0 && (
            <div className="sox-sched" aria-label="What happens to an unpaid invoice">
              <Chip tone="outline">Sent</Chip><i className="sep" />
              <Chip tone="neutral">Due after {Number.isNaN(terms.netDays) ? "?" : terms.netDays} days</Chip>
              {offsets.map((d, i) => <span key={i} style={{ display: "contents" }}><i className="sep" /><Chip tone={d > 0 ? "warning" : "info"}>{dayWords(d)}</Chip></span>)}
              <i className="sep" /><Chip tone="critical" dot>Work pauses {Number.isNaN(terms.pauseAfterDays) ? "?" : terms.pauseAfterDays} days late</Chip>
            </div>
          )}
          {problem && <p className="bx-err" role="alert">{problem}</p>}
        </Card>

        <section className="st-card">
          <header>
            <div><h2>Stripe</h2><p>What is set up, as yes or no. The key and the webhook secret are Worker secrets: this page never shows them.</p></div>
            {stripe && <Chip tone={missing ? "warning" : "positive"} dot>{missing ? `${missing} to set up` : "All set"}</Chip>}
          </header>
          <div className="st-card-body flush">
            {stripe === null && <p className="sox-row sox-sub">Checking…</p>}
            {stripe === false && <p className="sox-row bx-err" role="alert">Couldn’t read the Stripe status. Reload the page to try again.</p>}
            {stripe && (
              <ul className="sox-list">
                {rows.map((r) => {
                  // Live mode is set up, but it is the one state that charges real money, so it reads amber.
                  const live = r.label === "Stripe key" && stripe.mode === "live";
                  const tone = live || !r.ok ? "warning" : "positive";
                  return (
                    <li key={r.label} className="sox-row">
                      <span className={`sox-tile ${tone}`}><Icon name={live ? "card" : r.ok ? "check" : "alert"} size={16} /></span>
                      <div className="sox-main"><b>{r.label}</b><small>{live ? "Live mode: an approved invoice charges a real client. " : ""}{r.hint}</small></div>
                      <Chip tone={tone} dot>{r.text}</Chip>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <Card title="Events to switch on in Stripe" sub={`In Stripe, add a webhook endpoint at this address and enable exactly these ${WEBHOOK_EVENTS.length} events. Its signing secret is the webhook secret above.`}>
          <div className="sox-endpoint"><Icon name="link" size={14} /><code>{origin}{WEBHOOK_PATH}</code></div>
          <div className="sox-events">{WEBHOOK_EVENTS.map((e) => <code key={e}>{e}</code>)}</div>
        </Card>
      </div>
    </SettingsPage>
  );
}
