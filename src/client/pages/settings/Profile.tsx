import { useState } from "react";
import { Link } from "react-router-dom";
import Icon from "../../components/Icon";
import SettingsPage, { Callout, Card, Count, Field, Row } from "../../components/SettingsPage";
import { useSettingsDoc } from "../../settingsData";
import { hasBuiltSignature, isHttps } from "../../settingsPagesView";

const OFFER_MAX = 300;

/** The logo as it will look on shared reports; a broken or blank address shows the empty tile. */
function LogoTile({ url }: { url: string }) {
  const [bad, setBad] = useState("");
  const show = isHttps(url) && bad !== url;
  return <div className="sp-tile">{show ? <img src={url.trim()} alt="" onError={() => setBad(url)} /> : <Icon name="image" size={18} />}</div>;
}

/** Settings > You > Profile: who the drafts, the crawler and shared reports say you are. */
export default function Profile() {
  const doc = useSettingsDoc();
  const { value: v, set, errors } = doc;
  const logo = v("logo_url");
  const logoBad = logo.trim() !== "" && !isHttps(logo);
  return (
    <SettingsPage title="Profile" badge={<span className="badge2 info"><i className="dot" />Shown on shared reports</span>} doc={doc}>
      <Card title="Who you are" sub="Used in drafts, in the crawler’s user-agent, and on shared reports.">
        <Row>
          <Field label="Your name" htmlFor="your_name"><input id="your_name" maxLength={200} value={v("your_name")} onChange={(e) => set("your_name", e.target.value)} /></Field>
          <Field label="Business name" htmlFor="business_name"><input id="business_name" maxLength={200} value={v("business_name")} onChange={(e) => set("business_name", e.target.value)} /></Field>
        </Row>
        <Field label="Contact email" htmlFor="contact_email" help="Public on shared reports and sent with every site check.">
          <input id="contact_email" type="email" maxLength={200} autoComplete="email" value={v("contact_email")} onChange={(e) => set("contact_email", e.target.value)} />
        </Field>
        <div className="sp-logo">
          <LogoTile url={logo} />
          <div className="sp-lf">
            <Field label="Logo URL" htmlFor="logo_url" help="Must start with https." error={errors.logo_url ?? (logoBad ? "Logo URL must be an https:// link" : undefined)}>
              <input id="logo_url" inputMode="url" maxLength={500} placeholder="https://yoursite.com/logo.svg" value={logo} onChange={(e) => set("logo_url", e.target.value)} />
            </Field>
          </div>
        </div>
      </Card>
      <Card title="What you offer" sub="A sentence or two. Drafts use this to describe you.">
        <textarea className="st-input" aria-label="What you offer" maxLength={OFFER_MAX} value={v("services_blurb")} onChange={(e) => set("services_blurb", e.target.value)} />
        <Count n={v("services_blurb").length} max={OFFER_MAX} />
      </Card>
      <Card title="Plain-text signature" sub="Only used when you haven’t built a signature in Email signature.">
        {doc.saved && hasBuiltSignature(doc.saved)
          ? <Callout action={<Link to="/settings/signature">Open Email signature</Link>}>You have a built signature, so this one is not used.</Callout>
          : <textarea className="st-input" aria-label="Plain-text signature" rows={4} maxLength={1000} placeholder={"Your name\nYour title and website"} value={v("signature")} onChange={(e) => set("signature", e.target.value)} />}
      </Card>
    </SettingsPage>
  );
}
