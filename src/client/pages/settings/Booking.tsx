import { useState } from "react";
import { Chip } from "../../components/ds";
import Icon from "../../components/Icon";
import SettingsPage, { Callout, Card, Field } from "../../components/SettingsPage";
import { budgetProblem, readConfig, WEEKDAYS, windowProblem, type BookingConfig } from "../../bookingView";
import { dollars, parseDollars } from "../../packagesView";
import { useSettingsDoc } from "../../settingsData";

type Option = BookingConfig["budgetOptions"][number];
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const STEPS = [10, 15, 20, 30] as const;

/** Minutes between two "HH:MM" times, for the weekly total. */
const span = (w: { start: string; end: string }) => {
  const m = (t: string) => { const [h, mm] = t.split(":").map(Number); return h * 60 + (mm || 0); };
  return Math.max(0, m(w.end) - m(w.start));
};
const hoursText = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h ${m}m` : `${h}h`; };

/** One budget option: its label and the lowest amount it stands for. The amount is typed as text and only applied once it is a valid dollar figure. */
function BudgetRow({ o, onChange, onRemove, canRemove }: { o: Option; onChange: (next: Option) => void; onRemove: () => void; canRemove: boolean }) {
  const [text, setText] = useState(String(o.minCents / 100));
  const bad = parseDollars(text) === null;
  return (
    <li className="sox-budget">
      <input id={`bk-l-${o.id}`} className="in" aria-label="Label" value={o.label} maxLength={60} onChange={(e) => onChange({ ...o, label: e.target.value })} />
      <span className="sox-money"><span aria-hidden="true">$</span>
        <input id={`bk-m-${o.id}`} className="in" aria-label={`${o.label || "Option"} starts at (USD)`} inputMode="decimal" value={text} aria-invalid={bad}
          onChange={(e) => { setText(e.target.value); const c = parseDollars(e.target.value); if (c !== null) onChange({ ...o, minCents: c }); }} /></span>
      <button type="button" className="sox-x" onClick={onRemove} disabled={!canRemove} aria-label={`Remove ${o.label || "option"}`} title={canRemove ? "Remove" : "Keep at least one option"}><Icon name="x" size={14} /></button>
    </li>
  );
}

/** Settings > Booking: when people can book a call, and the budget choices on the booking form. Saved as one JSON document. */
export default function Booking() {
  const doc = useSettingsDoc();
  const cfg = readConfig(doc.value("booking_config"));
  const update = (patch: Partial<BookingConfig>) => doc.set("booking_config", JSON.stringify({ ...cfg, ...patch }));
  const num = (key: "minNoticeHours" | "horizonDays" | "bufferMin") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    if (e.target.value.trim() !== "" && Number.isFinite(n)) update({ [key]: Math.round(n) });
  };
  const setWindow = (i: number, patch: Partial<BookingConfig["windows"][number]>) => update({ windows: cfg.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  const budget = budgetProblem(cfg.budgetOptions, cfg.minEngagementCents);
  const weekly = cfg.windows.reduce((t, w) => t + span(w), 0);
  const days = new Set(cfg.windows.map((w) => w.weekday)).size;

  return (
    <SettingsPage title="Booking" width={760} doc={doc} sub="The hours people can book a call, and what the booking form asks."
      badge={doc.loaded ? (cfg.windows.length === 0 ? <Chip tone="warning" dot>No hours set</Chip> : <Chip tone="positive" dot>{days} {days === 1 ? "day" : "days"} · {hoursText(weekly)} a week</Chip>) : undefined}>
      <div className="bx sox">
        {cfg.windows.length === 0 && <Callout tone="warn" icon="alert">No hours are set, so the booking page shows no times. Add the hours you can take calls below.</Callout>}
        <section className="st-card">
          <header><div><h2>Weekly hours</h2><p>Times are in {cfg.timezone}. A call has to fit inside one block, so a 20-minute call can start up to 20 minutes before a block ends.</p></div></header>
          <div className="st-card-body flush">
            {DISPLAY_ORDER.map((wd) => {
              const rows = cfg.windows.map((w, i) => ({ w, i })).filter((r) => r.w.weekday === wd);
              return (
                <div key={wd} className={`sox-day${rows.length === 0 ? " off" : ""}`}>
                  <b>{WEEKDAYS[wd]}</b>
                  <div className="sox-wins">
                    {rows.map(({ w, i }) => {
                      const problem = windowProblem(w);
                      return (
                        <span key={i} style={{ display: "contents" }}>
                          <span className="sox-win" data-bad={problem ? "" : undefined}>
                            <input className="in" type="time" aria-label={`${WEEKDAYS[wd]} start`} value={w.start} aria-invalid={!!problem} onChange={(e) => setWindow(i, { start: e.target.value })} />
                            <span aria-hidden="true">to</span>
                            <input className="in" type="time" aria-label={`${WEEKDAYS[wd]} end`} value={w.end} aria-invalid={!!problem} onChange={(e) => setWindow(i, { end: e.target.value })} />
                            <button type="button" className="sox-x" onClick={() => update({ windows: cfg.windows.filter((_, j) => j !== i) })} aria-label={`Remove ${WEEKDAYS[wd]} ${w.start} to ${w.end}`} title="Remove these hours"><Icon name="x" size={13} /></button>
                          </span>
                          {problem && <p className="bx-err" role="alert">{problem}</p>}
                        </span>
                      );
                    })}
                    <button type="button" className="sox-add" onClick={() => update({ windows: [...cfg.windows, { weekday: wd, start: "09:00", end: "12:00" }] })}>
                      <Icon name="plus" size={13} />{rows.length === 0 ? `Add hours on ${WEEKDAYS[wd]}` : "Add hours"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <Card title="Rules" sub="How far ahead and how soon someone can book, and the gaps kept around your other events.">
          <div className="sox-grid">
            <Field label="Minimum notice (hours)" htmlFor="bk-notice" help="1 to 168. Nobody can book sooner than this.">
              <input id="bk-notice" className="sox-w" type="number" min={1} max={168} value={cfg.minNoticeHours} onChange={num("minNoticeHours")} />
            </Field>
            <Field label="Book up to (days ahead)" htmlFor="bk-horizon" help="1 to 60.">
              <input id="bk-horizon" className="sox-w" type="number" min={1} max={60} value={cfg.horizonDays} onChange={num("horizonDays")} />
            </Field>
            <Field label="Buffer around other events (minutes)" htmlFor="bk-buffer" help="0 to 60. Kept free before and after anything on your calendar.">
              <input id="bk-buffer" className="sox-w" type="number" min={0} max={60} value={cfg.bufferMin} onChange={num("bufferMin")} />
            </Field>
            <Field label="Start times every" htmlFor="bk-step" help="Minutes between offered start times.">
              <select id="bk-step" className="sox-w" value={cfg.slotStepMin} onChange={(e) => update({ slotStepMin: Number(e.target.value) as BookingConfig["slotStepMin"] })}>
                {STEPS.map((s) => <option key={s} value={s}>{s} minutes</option>)}
              </select>
            </Field>
            <div className="wide">
              <Field label="Time zone" htmlFor="bk-tz" help="An IANA name, like America/Los_Angeles. Your hours above are in this zone; visitors see their own.">
                <input id="bk-tz" className="sox-w l" value={cfg.timezone} maxLength={64} onChange={(e) => update({ timezone: e.target.value.trim() })} />
              </Field>
            </div>
          </div>
        </Card>
        <section className="st-card">
          <header><div><h2>Budget choices</h2><p>What the booking form offers. The lowest one can't be under your minimum engagement.</p></div></header>
          <div className="st-card-body">
            <Field label="Minimum engagement (USD)" htmlFor="bk-min" help="Your smallest package. The default is the Quick Fix price.">
              <MinEngagement cents={cfg.minEngagementCents} onChange={(c) => update({ minEngagementCents: c })} />
            </Field>
          </div>
          <ul className="sox-list">
            <li className="sox-budget head" aria-hidden="true"><span>Label on the form</span><span>Starts at</span><span /></li>
            {cfg.budgetOptions.map((o, i) => (
              <BudgetRow key={o.id} o={o} canRemove={cfg.budgetOptions.length > 1}
                onChange={(next) => update({ budgetOptions: cfg.budgetOptions.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => update({ budgetOptions: cfg.budgetOptions.filter((_, j) => j !== i) })} />
            ))}
          </ul>
          <div className="sox-card-foot">
            <button type="button" className="sox-add" onClick={() => update({ budgetOptions: [...cfg.budgetOptions, { id: `opt-${Date.now().toString(36)}`, label: "New option", minCents: cfg.minEngagementCents }] })}><Icon name="plus" size={13} />Add a budget option</button>
            <span style={{ flex: 1 }} />
            {budget
              ? <p className="bx-err" role="alert">{budget}</p>
              : <p className="sox-sub">Lowest option {dollars(Math.min(...cfg.budgetOptions.map((o) => o.minCents)))}, at or above your {dollars(cfg.minEngagementCents)} minimum.</p>}
          </div>
        </section>
      </div>
    </SettingsPage>
  );
}

function MinEngagement({ cents, onChange }: { cents: number; onChange: (cents: number) => void }) {
  const [text, setText] = useState(String(cents / 100));
  return <span className="sox-money sox-w"><span aria-hidden="true">$</span><input id="bk-min" inputMode="decimal" value={text} aria-invalid={parseDollars(text) === null}
    onChange={(e) => { setText(e.target.value); const c = parseDollars(e.target.value); if (c !== null) onChange(c); }} /></span>;
}
