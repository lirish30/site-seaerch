import { useState } from "react";
import Icon from "../../components/Icon";
import SettingsPage from "../../components/SettingsPage";
import ServicesEditor, { useServices } from "../../components/ServicesEditor";
import { Pill } from "../../components/settingsBits";
import { serviceBadge } from "../../settingsView";

/** Settings > Services you sell: the catalog "Recommended pitch" picks from. */
export default function Services() {
  const sv = useServices();
  const [adding, setAdding] = useState(false);
  return (
    <SettingsPage title="Services you sell" width={900}
      sub="“Recommended pitch” on each lead picks from the services you mark active."
      badge={sv.services && <Pill>{serviceBadge(sv.services)}</Pill>}
      action={<button type="button" className="btn primary" onClick={() => setAdding(true)} disabled={!sv.services}><Icon name="plus" size={16} className="bx-plus" />Add service</button>}>
      <div className="bx">
        <ServicesEditor sv={sv} adding={adding} onCloseAdd={() => setAdding(false)} />
      </div>
    </SettingsPage>
  );
}
