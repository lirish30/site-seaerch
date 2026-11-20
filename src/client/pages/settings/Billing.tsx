import { useEffect, useState } from "react";
import { api } from "../../api";
import Icon from "../../components/Icon";
import SettingsPage, { Callout, Card, Field, Row } from "../../components/SettingsPage";
import { billingTermsProblem, offsetsText, parseOffsets, readBillingTerms, stripeRows, WEBHOOK_EVENTS, WEBHOOK_PATH, type BillingTerms, type StripeStatus } from "../../billingView";
import { useSettingsDoc } from "../../settingsData";

type NumKey = "netDays" | "pauseAfterDays" | "termNoticeDays";
const NUM_KEYS: NumKey[] = ["netDays", "pauseAfterDays", "termNoticeDays"];
/** A whole number typed in a box; NaN for blank or anything else, which `billingTermsProblem` refuses. */
const whole = (raw: string): number => (/^-?\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN);

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

  return (
    <SettingsPage title="Billing" width={760} doc={doc} blocked={problem ?? undefined} sub="How long a client has to pay, when reminders go, and what is set up in Stripe.">
      <div className="bx">
        <Card title="Invoice terms" sub="Saved as one document. The worker checks it again when you save and says which number is wrong.">
          <Row>
            <Field label="Days to pay an invoice" htmlFor="bl-net" help="1 to 60. The due date is this many days after an invoice is sent.">
              <input id="bl-net" className="in" inputMode="numeric" value={text("netDays")} aria-invalid={Number.isNaN(terms.netDays)} onChange={num("netDays")} />
            </Field>
            <Field label="Term notice (days before the term ends)" htmlFor="bl-notice" help="7 to 90. The client is told a subscription's term is ending this many days ahead.">
              <input id="bl-notice" className="in" inputMode="numeric" value={text("termNoticeDays")} aria-invalid={Number.isNaN(terms.termNoticeDays)} onChange={num("termNoticeDays")} />
            </Field>
          </Row>
          <Field label="Reminder days" htmlFor="bl-offsets" help="Days from the due date, in order, 1 to 6 of them (-30 to 60). Negative is before it: -3, 0, 3, 7 is three days before, on the day, then 3 and 7 days late. Each reminder is a mail you approve.">
            <input id="bl-offsets" className="in" inputMode="text" autoComplete="off" value={text("reminderOffsets")} aria-invalid={offsets === null}
              onChange={(e) => { setTyped((t) => ({ ...t, reminderOffsets: e.target.value })); const o = parseOffsets(e.target.value); if (o) save({ reminderOffsets: o }); }} />
          </Field>
          <Field label="Pause work after (days past due)" htmlFor="bl-pause" help="7 to 60, and after the last reminder. Your tasks and Claude's for that client stop (a hold). The client's site and hosting are never touched.">
            <input id="bl-pause" className="in" inputMode="numeric" value={text("pauseAfterDays")} aria-invalid={Number.isNaN(terms.pauseAfterDays)} onChange={num("pauseAfterDays")} />
          </Field>
          {problem && <p className="bx-err" role="alert">{problem}</p>}
        </Card>

        <Card title="Stripe" sub="What is set up, as yes or no. The key and the webhook secret are Worker secrets: this page never shows them.">
          {stripe === null && <p className="bx-muted">Checking…</p>}
          {stripe === false && <Callout tone="warn" icon="alert">Couldn’t read the Stripe status. Reload the page to try again.</Callout>}
          {stripe && stripe.mode === "live" && <Callout tone="warn" icon="alert">Live mode: an approved invoice charges a real client.</Callout>}
          {stripe && (
            <ul className="st-list bl-stripe">
              {rows.map((r) => (
                <li key={r.label} className="st-list-row bl-stripe-row">
                  <div><b>{r.label}</b><p className="bx-muted">{r.hint}</p></div>
                  <span className={`bl-ok${r.ok ? " yes" : ""}`}><Icon name={r.ok ? "check" : "alert"} size={14} />{r.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Events to switch on in Stripe" sub={<>In Stripe, add a webhook endpoint at <code>{WEBHOOK_PATH}</code> on this app’s address ({typeof location === "undefined" ? "" : location.origin}) and enable exactly these seven events. Its signing secret is the webhook secret above.</>}>
          <ul className="bl-events">{WEBHOOK_EVENTS.map((e) => <li key={e}><code>{e}</code></li>)}</ul>
        </Card>
      </div>
    </SettingsPage>
  );
}
