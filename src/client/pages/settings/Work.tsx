import { useState } from "react";
import SettingsPage, { Callout, Card, Field, Row, Segmented } from "../../components/SettingsPage";
import { parseDollars } from "../../packagesView";
import { useSettingsDoc } from "../../settingsData";
import { hoursToMinutes, readWorkDraft } from "../../settingsPagesView";
import type { WorkConfig } from "../../../worker/time/config";

/** Settings > Work: what an hour of your time costs, which day the timesheet week starts, and when a forgotten timer is cut off. Saved as one JSON document the server checks. */
export default function Work() {
  const doc = useSettingsDoc();
  const cfg = readWorkDraft(doc.value("work_config"));
  const update = (patch: Partial<WorkConfig>) => doc.set("work_config", JSON.stringify({ ...cfg, ...patch }));
  const [rate, setRate] = useState<string | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const rateText = rate ?? (cfg.costRateCentsPerHour === 0 ? "" : String(cfg.costRateCentsPerHour / 100));
  const capText = cap ?? String(cfg.timerCapMinutes / 60);
  const rateBad = rateText.trim() !== "" && parseDollars(rateText) === null;
  const capBad = hoursToMinutes(capText) === null;

  return (
    <SettingsPage title="Work" width={760} doc={doc} sub="How your time is counted on projects and the timesheet.">
      <div className="wk">
        <Card title="Cost rate" sub="What an hour of your time costs you. A project's profit is its payments less your time at this rate.">
          <Callout tone="info">The cost rate is yours alone and never appears on a client page. It is not the rate on a change order.</Callout>
          <Field label="Cost of an hour (USD)" htmlFor="wk-rate" error={rateBad ? "Enter dollars, like 45 or 62.50." : undefined} help="Leave it blank to leave your time out of a project's profit. At most $500.">
            <input id="wk-rate" className="in" inputMode="decimal" autoComplete="off" value={rateText} aria-invalid={rateBad}
              onChange={(e) => {
                setRate(e.target.value);
                if (e.target.value.trim() === "") update({ costRateCentsPerHour: 0 });
                else { const c = parseDollars(e.target.value); if (c !== null) update({ costRateCentsPerHour: c }); }
              }} />
          </Field>
        </Card>
        <Card title="Timesheet">
          <Row>
            <Field label="The week starts on" help="Used by the timesheet grid.">
              <Segmented label="The week starts on" value={String(cfg.weekStartsOn) as "0" | "1"} options={[{ value: "1", label: "Monday" }, { value: "0", label: "Sunday" }]} onChange={(v) => update({ weekStartsOn: v === "0" ? 0 : 1 })} />
            </Field>
            <Field label="A timer left running stops after (hours)" htmlFor="wk-cap" error={capBad ? "Enter hours, like 12." : undefined} help="From 1 to 24. A timer left on is saved at this length with a note.">
              <input id="wk-cap" className="in" inputMode="decimal" value={capText} aria-invalid={capBad}
                onChange={(e) => { setCap(e.target.value); const m = hoursToMinutes(e.target.value); if (m !== null) update({ timerCapMinutes: m }); }} />
            </Field>
          </Row>
        </Card>
      </div>
    </SettingsPage>
  );
}
