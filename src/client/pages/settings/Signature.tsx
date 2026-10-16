import SettingsPage from "../../components/SettingsPage";
import SignatureBuilder from "../../components/SignatureBuilder";
import { useSettingsDoc } from "../../settingsData";
import { hasBuiltSignature } from "../../settingsPagesView";

/** Settings > You > Email signature: the rich signature added to the end of every draft. */
export default function Signature() {
  const doc = useSettingsDoc();
  const built = doc.saved ? hasBuiltSignature(doc.saved) : false;
  return (
    <SettingsPage title="Email signature" sub="Added to the end of every draft. The body never repeats it." doc={doc} width={1004}
      badge={doc.loaded ? (built ? <span className="badge2 positive"><i className="dot" />Complete</span> : <span className="badge2 warning"><i className="dot" />Not set up</span>) : undefined}>
      <SignatureBuilder value={doc.value("signature_json")} onChange={(json) => doc.set("signature_json", json)} />
    </SettingsPage>
  );
}
