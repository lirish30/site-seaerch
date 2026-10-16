import SettingsPage from "../../components/SettingsPage";
import SuppressionsEditor, { useSuppressions } from "../../components/SuppressionsEditor";
import { Pill } from "../../components/settingsBits";
import { suppressionBadge } from "../../settingsView";

/** Settings > Suppressions: businesses that are never searched, drafted for or exported. */
export default function Suppressions() {
  const sup = useSuppressions();
  return (
    <SettingsPage title="Suppressions" width={900}
      sub="Businesses that are never drafted or exported: clients, competitors, opt-outs and active deals."
      badge={sup.rows && <Pill>{suppressionBadge(sup.rows)}</Pill>}>
      <div className="bx"><SuppressionsEditor sup={sup} /></div>
    </SettingsPage>
  );
}
