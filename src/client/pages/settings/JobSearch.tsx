import SettingsPage, { Callout, Card, Count, Field, Row, Segmented } from "../../components/SettingsPage";
import { useSettingsDoc } from "../../settingsData";

const BIO_MAX = 400;

/** Settings > You > Job search: what a full-time email can say about you. */
export default function JobSearch() {
  const doc = useSettingsDoc();
  const { value: v, set, errors } = doc;
  const resume = v("resume_url").trim();
  const hasResume = String(doc.saved?.resume_url ?? "").trim() !== "";
  return (
    <SettingsPage title="Job search" sub="Used when you write emails for a full-time role." doc={doc}
      badge={doc.loaded ? (hasResume ? <span className="badge2 positive"><i className="dot" />Complete</span> : <span className="badge2 warning"><i className="dot" />Resume link missing</span>) : undefined}>
      <Card title="About you" sub="How drafts introduce you.">
        <Row>
          <Field label="Your role" htmlFor="role_title"><input id="role_title" maxLength={200} placeholder="Front-end developer" value={v("role_title")} onChange={(e) => set("role_title", e.target.value)} /></Field>
          <Field label="Availability" htmlFor="availability"><input id="availability" maxLength={300} placeholder="Open to full-time roles from January" value={v("availability")} onChange={(e) => set("availability", e.target.value)} /></Field>
        </Row>
        <Field label="Short bio" htmlFor="bio">
          <textarea id="bio" className="sj-bio" maxLength={BIO_MAX} placeholder="Two or three sentences: what you do well, what you care about. Emails only use what you write here." value={v("bio")} onChange={(e) => set("bio", e.target.value)} />
          <Count n={v("bio").length} max={BIO_MAX} />
        </Field>
      </Card>
      <Card title="What you’re looking for" sub="Drafts mention this in one sentence, never more.">
        <Field label="Looking for" htmlFor="goal_line"><input id="goal_line" maxLength={500} placeholder="A full-time front-end role on a small product team" value={v("goal_line")} onChange={(e) => set("goal_line", e.target.value)} /></Field>
        <Field label="Resume link" htmlFor="resume_url" help="Must start with https. Drafts only link it when asked." error={errors.resume_url}>
          <input id="resume_url" inputMode="url" maxLength={500} value={v("resume_url")} onChange={(e) => set("resume_url", e.target.value)} />
        </Field>
        {!resume && <Callout tone="warn" icon="alert" compact>Add a resume link so full-time drafts can offer it.</Callout>}
      </Card>
      <Card title="Default purpose" sub="You can switch per email on the lead page.">
        <Segmented label="Write emails for" value={v("default_purpose") === "freelance" ? "freelance" : "full_time"} onChange={(p) => set("default_purpose", p)}
          options={[{ value: "full_time", label: "A full-time role", icon: "briefcase" }, { value: "freelance", label: "Freelance work", icon: "zap" }]} />
      </Card>
    </SettingsPage>
  );
}
