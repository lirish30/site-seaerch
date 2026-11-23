import { useEffect, useState } from "react";
import { Chip } from "../../components/ds";
import Icon from "../../components/Icon";
import SettingsPage, { Card, Field, Segmented } from "../../components/SettingsPage";
import { dollars, parseDollars } from "../../packagesView";
import { useSettingsDoc } from "../../settingsData";
import { clientLimitProblem, costRateProblem, hoursToMinutes, readWorkDraft, timerCapProblem, weeklyHoursProblem } from "../../settingsPagesView";
import type { WorkConfig } from "../../../worker/time/config";

/** Settings > Work: what an hour of your time costs, which day the timesheet week starts, and when a forgotten timer is cut off. Saved as one JSON document the server checks. */
export default function Work() {
  const doc = useSettingsDoc();
  const cfg = readWorkDraft(doc.value("work_config"));
  const update = (patch: Partial<WorkConfig>) => doc.set("work_config", JSON.stringify({ ...cfg, ...patch }));
  // What is typed in the boxes (null: show the saved or edited value). A save or a Discard empties the edits, and then the boxes follow the stored values again.
  const [rate, setRate] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [weekly, setWeekly] = useState<string | null>(null);
  const [clients, setClients] = useState<string | null>(null);
  useEffect(() => { if (!doc.dirty) { setRate(null); setCap(null); setWeekly(null); setClients(null); } }, [doc.dirty]);
  const rateText = rate ?? (cfg.costRateCentsPerHour === 0 ? "" : String(cfg.costRateCentsPerHour / 100));
  const capText = cap ?? String(cfg.timerCapMinutes / 60);
  const weeklyText = weekly ?? String(cfg.weeklyHoursLimit);
  const clientsText = clients ?? String(cfg.clientLimit);
  const rateBad = costRateProblem(rateText);
  const capBad = timerCapProblem(capText);
  const weeklyBad = weeklyHoursProblem(weeklyText);
  const clientsBad = clientLimitProblem(clientsText);

  return (
    <SettingsPage title="Work" width={760} doc={doc} blocked={rateBad ?? capBad ?? weeklyBad ?? clientsBad ?? undefined} sub="How your time is counted on projects and the timesheet."
      badge={doc.loaded ? (cfg.costRateCentsPerHour > 0 ? <Chip tone="positive" dot>Cost rate {dollars(cfg.costRateCentsPerHour)}/hr</Chip> : <Chip tone="warning" dot>Cost rate not set</Chip>) : undefined}>
      <div className="bx sox">
        <Card title="Cost rate" sub="What an hour of your time costs you. A project's profit is its payments less your time at this rate.">
          <Field label="Cost of an hour (USD)" htmlFor="wk-rate" error={rateBad ?? undefined} help="Leave it blank to leave your time out of a project's profit. At most $500.">
            <span className="sox-money sox-w"><span aria-hidden="true">$</span>
              <input id="wk-rate" inputMode="decimal" autoComplete="off" placeholder="Not set" value={rateText} aria-invalid={!!rateBad}
                onChange={(e) => {
                  setRate(e.target.value);
                  if (e.target.value.trim() === "") update({ costRateCentsPerHour: 0 });
                  else { const c = parseDollars(e.target.value); if (c !== null) update({ costRateCentsPerHour: c }); }
                }} /></span>
          </Field>
          <p className="sox-foot"><Icon name="eye" size={14} />Only you see this. It never appears on a client page and it is not the rate on a change order.</p>
        </Card>
        <Card title="Timesheet" sub="How the week is laid out and what happens to a timer you forget.">
          <div className="sox-grid">
            <Field label="The week starts on" help="Used by the timesheet grid.">
              <Segmented label="The week starts on" value={String(cfg.weekStartsOn) as "0" | "1"} options={[{ value: "1", label: "Monday" }, { value: "0", label: "Sunday" }]} onChange={(v) => update({ weekStartsOn: v === "0" ? 0 : 1 })} />
            </Field>
            <Field label="A timer left running stops after (hours)" htmlFor="wk-cap" error={capBad ?? undefined} help="1 to 24. A timer left on is saved at this length with a note.">
              <input id="wk-cap" className="sox-w" inputMode="decimal" value={capText} aria-invalid={!!capBad}
                onChange={(e) => { setCap(e.target.value); const m = hoursToMinutes(e.target.value); if (m !== null) update({ timerCapMinutes: m }); }} />
            </Field>
          </div>
        </Card>
        <Card title="Capacity" sub="How much you want to carry. Going past a limit only shows a warning; nothing is ever blocked.">
          <div className="sox-grid">
            <Field label="Hours of your work in a week" htmlFor="wk-weekly" error={weeklyBad ?? undefined} help="Whole hours, 1 to 80. This week and next week are checked against it.">
              <input id="wk-weekly" className="sox-w" inputMode="numeric" value={weeklyText} aria-invalid={!!weeklyBad}
                onChange={(e) => { setWeekly(e.target.value); if (!weeklyHoursProblem(e.target.value)) update({ weeklyHoursLimit: Number(e.target.value.trim()) }); }} />
            </Field>
            <Field label="Live clients at once" htmlFor="wk-clients" error={clientsBad ?? undefined} help="A whole number, 1 to 200. Test clients are never counted.">
              <input id="wk-clients" className="sox-w" inputMode="numeric" value={clientsText} aria-invalid={!!clientsBad}
                onChange={(e) => { setClients(e.target.value); if (!clientLimitProblem(e.target.value)) update({ clientLimit: Number(e.target.value.trim()) }); }} />
            </Field>
          </div>
        </Card>
      </div>
    </SettingsPage>
  );
}
