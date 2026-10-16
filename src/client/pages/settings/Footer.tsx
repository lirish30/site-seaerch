import Icon, { type IconName } from "../../components/Icon";
import SettingsPage, { Card, Field } from "../../components/SettingsPage";
import { Toggle } from "../../components/settingsBits";
import { useSettingsDoc } from "../../settingsData";
import { footerLines, signatureLine } from "../../settingsView";

/** One "when to include it" row: the setting, an icon, and a line that says what the switch currently means. */
const WHEN: { key: string; icon: IconName; title: string; on: string; off: string }[] = [
  { key: "footer_freelance", icon: "zap", title: "Freelance emails", on: "On by default. Proposal-style outreach.", off: "Off by default. Proposal-style outreach." },
  { key: "footer_full_time", icon: "briefcase", title: "Full-time emails", on: "On by default. Personal notes can read better without it.", off: "Off by default. Personal notes read better without it." },
];

/** Settings > Mailing footer: the address and opt-out line under an email, and which kinds of email carry them by default. */
export default function Footer() {
  const doc = useSettingsDoc();
  const address = doc.value("physical_address"), optOut = doc.value("opt_out_line");
  const lines = footerLines(address, optOut);
  const sign = signatureLine(doc.value("your_name"), doc.value("role_title"));
  // The default for each kind of email is on unless the stored value says 0 (older databases have no value until the first save).
  const on = (k: string) => (k === "footer_full_time" ? doc.value(k) === "1" : doc.value(k) !== "0");
  return (
    <SettingsPage title="Mailing footer" width={720} doc={doc} sub="A mailing address and opt-out line you can add to the bottom of an email.">
      <div className="bx mf">
        <Card title="Footer text">
          <Field label="Mailing address" htmlFor="mf-address">
            <textarea id="mf-address" className="mf-ta" value={address} maxLength={500} placeholder="e.g. Your Studio · 123 Main St, Boise, ID 83702" onChange={(e) => doc.set("physical_address", e.target.value)} />
          </Field>
          <Field label="Opt-out line" htmlFor="mf-optout">
            <textarea id="mf-optout" className="mf-ta" value={optOut} maxLength={500} placeholder="e.g. Not interested? Reply “no thanks” and I won’t email again." onChange={(e) => doc.set("opt_out_line", e.target.value)} />
          </Field>
        </Card>
        <Card title="When to include it" sub="You can still switch it per email in the composer.">
          {WHEN.map((w) => (
            <div key={w.key} className="mf-when">
              <span className="mf-tile"><Icon name={w.icon} size={15} /></span>
              <div className="mf-text"><b>{w.title}</b><span>{on(w.key) ? w.on : w.off}</span></div>
              <Toggle checked={on(w.key)} onChange={(v) => doc.set(w.key, v ? 1 : 0)} label={`${w.title}: include the footer`} />
            </div>
          ))}
        </Card>
        <h2 className="mf-kicker">Preview</h2>
        <div className="mf-preview" aria-label="How the footer appears under an email">
          <p className="lead">…happy to put together a short proposal.</p>
          {sign && <p className="sig">{sign}</p>}
          {lines.length > 0 ? <>
            <hr />
            {lines.map((l) => <p key={l} className="foot">{l}</p>)}
          </> : <p className="foot empty">Add a mailing address or an opt-out line above to see the footer.</p>}
        </div>
      </div>
    </SettingsPage>
  );
}
