import { useState } from "react";
import Icon from "../../components/Icon";
import SettingsPage from "../../components/SettingsPage";
import FitProfilesEditor, { useFitProfiles } from "../../components/FitProfilesEditor";
import { Pill } from "../../components/settingsBits";
import { fitBadge } from "../../settingsView";

/** Settings > Fit profiles: who you want to work with. A lead's Fit is its best match across the active profiles. */
export default function FitProfiles() {
  const fp = useFitProfiles();
  const [adding, setAdding] = useState(false);
  const active = fp.profiles?.filter((p) => p.active).length ?? 0;
  return (
    <SettingsPage title="Fit profiles" width={900}
      sub="Describe who you want to work with. Each lead’s Fit is the best match across active profiles."
      badge={fp.profiles && <Pill tone={active > 0 ? "positive" : "neutral"}>{fitBadge(fp.profiles)}</Pill>}
      action={<button type="button" className="btn primary" onClick={() => setAdding(true)} disabled={!fp.profiles}><Icon name="plus" size={16} className="bx-plus" />Add fit profile</button>}>
      <div className="bx">
        <FitProfilesEditor fp={fp} adding={adding} onCloseAdd={() => setAdding(false)} />
      </div>
    </SettingsPage>
  );
}
