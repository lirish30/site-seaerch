import SettingsPage from "../../components/SettingsPage";
import SuppressionsEditor, { useSuppressions } from "../../components/SuppressionsEditor";
import DoNotContactEditor from "../../components/DoNotContactEditor";
import { Pill } from "../../components/settingsBits";
import { suppressionBadge } from "../../settingsView";

/** Settings > Suppressions: businesses that are never searched, drafted for or exported, and the do-not-contact list for outreach. */
export default function Suppressions() {
  const sup = useSuppressions();
  return (
    <SettingsPage title="Suppressions" width={900}
      sub="Businesses that are never drafted or exported: clients, competitors, opt-outs and active deals."
      badge={sup.rows && <Pill>{suppressionBadge(sup.rows)}</Pill>}>
      <div className="bx"><SuppressionsEditor sup={sup} /></div>
      <div className="bx" style={{ marginTop: 28 }}>
        <div>
          <h2 style={{ margin: 0, font: "600 15px/22px var(--font)" }}>Do not contact</h2>
          <p className="bx-muted" style={{ margin: "4px 0 0" }}>
            Emails, domains and company names outreach is never sent to. A listed domain also blocks its subdomains and www, and an existing client (a lead marked won) is blocked automatically.
          </p>
        </div>
        <DoNotContactEditor />
      </div>
    </SettingsPage>
  );
}
