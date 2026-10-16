import SettingsPage, { Card, Segmented } from "../../components/SettingsPage";
import { useSettingsDoc } from "../../settingsData";
import { CTAS, LENGTHS, TONES } from "../../settingsPagesView";

/** Settings > Outreach > Email voice: the defaults every draft starts from. */
export default function Voice() {
  const doc = useSettingsDoc();
  const { value: v, set } = doc;
  const tone = TONES.some((t) => t.value === v("tone_preset")) ? v("tone_preset") : TONES[0].value;
  const length = LENGTHS.some((l) => l.value === v("email_length")) ? v("email_length") : LENGTHS[0].value;
  const cta = CTAS.some((c) => c.value === v("cta_style")) ? v("cta_style") : CTAS[0].value;
  return (
    <SettingsPage title="Email voice" sub="The defaults every draft starts from. You can override tone per email." doc={doc}>
      <Card title="Tone">
        <div className="vo-tones" role="radiogroup" aria-label="Tone">
          {TONES.map((t) => (
            <label key={t.value} className="st-opt vo-tone">
              <input type="radio" name="tone_preset" value={t.value} checked={tone === t.value} onChange={() => set("tone_preset", t.value)} /><i className="radio" />
              <span className="t"><b>{t.label}</b><small>{t.hint}</small></span>
            </label>
          ))}
        </div>
      </Card>
      <Card title="Length" sub="Job emails run about 50 words longer.">
        <Segmented large label="Length" value={length} onChange={(l) => set("email_length", l)} options={LENGTHS.map((l) => ({ value: l.value, label: l.label, hint: l.words }))} />
      </Card>
      <Card title="What you ask them to do" sub="The single next step at the end of each email.">
        <div className="vo-ctas" role="radiogroup" aria-label="What you ask them to do">
          {CTAS.map((c) => (
            <label key={c.value} className="st-opt">
              <input type="radio" name="cta_style" value={c.value} checked={cta === c.value} onChange={() => set("cta_style", c.value)} /><i className="radio" />{c.label}
            </label>
          ))}
        </div>
      </Card>
      <Card title="Voice notes" sub="Phrases you use and things to avoid. Drafts follow these closely.">
        <div className="st-field">
          <textarea className="vo-notes" aria-label="Voice notes" maxLength={5000} rows={5} value={v("tone_notes")} onChange={(e) => set("tone_notes", e.target.value)}
            placeholder={"Say “I noticed”, not “I hope this finds you well”.\nNo exclamation marks."} />
        </div>
      </Card>
    </SettingsPage>
  );
}
