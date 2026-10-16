import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import Icon, { type IconName } from "../../components/Icon";
import SettingsPage from "../../components/SettingsPage";
import type { WorkSample } from "../../emailView";
import type { SettingsDoc, UsageRow } from "../../settingsData";
import {
  hasBuiltSignature, jobMissing, profileMissing, samplesNeeded, setupItems, setupSentence, suppressionWord, voiceSummary,
} from "../../settingsPagesView";
import type { FitProfile, Service, Suppression } from "../../types";

interface Google { configured: boolean; connected: boolean; email: string | null }
/** Each source loads on its own; `null` is still loading and `false` failed. */
interface Data {
  doc: SettingsDoc | null | false; usage: UsageRow[]; samples: WorkSample[] | null | false; services: Service[] | null | false;
  fits: FitProfile[] | null | false; supps: Suppression[] | null | false; google: Google | null | false;
}
type Tone = "positive" | "warning" | "";
interface Chip { tone: Tone; text: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const dollars = (n: number) => `$${n.toFixed(2)}`;
const limitText = (n: number) => (Number.isInteger(n) ? `$${n}` : dollars(n));

/** The overview card's status chip for one page, from whatever has loaded. `null` shows the loading chip. */
function chips(d: Data): Record<string, Chip | null> {
  const wait = (v: unknown, make: () => Chip): Chip | null => (v === null ? null : v === false ? { tone: "", text: "Couldn't load" } : make());
  const doc = d.doc || {};
  const missingJob = jobMissing(doc);
  const missingProfile = profileMissing(doc);
  return {
    profile: wait(d.doc, () => (missingProfile.length ? { tone: "warning", text: `Add ${missingProfile[0]}` } : { tone: "positive", text: "Complete" })),
    "job-search": wait(d.doc, () => (!String(doc.resume_url ?? "").trim() ? { tone: "warning", text: "Resume link missing" } : missingJob.length ? { tone: "warning", text: `Add ${missingJob[0]}` } : { tone: "positive", text: "Complete" })),
    signature: wait(d.doc, () => (hasBuiltSignature(doc) ? { tone: "positive", text: "Complete" } : String(doc.signature ?? "").trim() ? { tone: "", text: "Plain text only" } : { tone: "warning", text: "Not set up" })),
    voice: wait(d.doc, () => ({ tone: "", text: voiceSummary(String(doc.tone_preset), String(doc.email_length)) })),
    "work-samples": wait(d.samples, () => {
      const s = d.samples as WorkSample[]; const need = samplesNeeded(s);
      return !s.length ? { tone: "warning", text: "No samples yet" } : need ? { tone: "warning", text: `${plural(s.length, "sample")} · add ${need} more` } : { tone: "positive", text: plural(s.length, "sample") };
    }),
    services: wait(d.services, () => {
      const s = d.services as Service[]; const active = s.filter((x) => x.active).length;
      return active === 0 ? { tone: "warning", text: "No active services" } : { tone: "", text: `${plural(s.length, "service")} · ${plural(s.filter((x) => x.is_specialty).length, "specialty", "specialties")}` };
    }),
    "fit-profiles": wait(d.fits, () => {
      const n = (d.fits as FitProfile[]).filter((p) => p.active).length;
      return n ? { tone: "positive", text: `${n} active` } : { tone: "", text: "None active" };
    }),
    suppressions: wait(d.supps, () => ({ tone: "", text: (d.supps as Suppression[]).length ? suppressionWord(d.supps as Suppression[]) : "Nothing suppressed" })),
    scores: { tone: "", text: "Guide" },
    google: wait(d.google, () => {
      const g = d.google as Google;
      return !g.configured ? { tone: "", text: "Not set up" } : g.connected ? { tone: "positive", text: `Connected · ${g.email ?? "your account"}` } : { tone: "warning", text: "Not connected" };
    }),
    usage: wait(d.doc, () => ({ tone: "", text: `${dollars(d.usage.reduce((t, u) => t + u.est_cost_usd, 0))} of ${limitText(Number(doc.monthly_spend_limit_usd) || 0)}` })),
    footer: wait(d.doc, () => (String(doc.physical_address ?? "").trim() ? { tone: "", text: "On for freelance only" } : { tone: "warning", text: "Add a mailing address" })),
  };
}

interface CardDef { slug: string; title: string; icon: IconName; text: string }
const SECTIONS: { name: string; tint: "signal" | "info" | "positive" | "plain"; cards: CardDef[] }[] = [
  { name: "You", tint: "signal", cards: [
    { slug: "profile", title: "Profile", icon: "user", text: "Your name, business, contact email and logo. Shown on shared reports." },
    { slug: "job-search", title: "Job search", icon: "briefcase", text: "Role, short bio, what you’re looking for and your resume link." },
    { slug: "signature", title: "Email signature", icon: "pen", text: "Name, title, links and a graphic, added to every draft." },
  ] },
  { name: "Outreach", tint: "info", cards: [
    { slug: "voice", title: "Email voice", icon: "mail", text: "Tone, length, what you ask for, and phrases you use or avoid." },
    { slug: "work-samples", title: "Work samples", icon: "image", text: "Projects your full-time emails can point to." },
    { slug: "services", title: "Services you sell", icon: "list", text: "The catalog behind “Recommended pitch”." },
  ] },
  { name: "Lead scoring", tint: "positive", cards: [
    { slug: "fit-profiles", title: "Fit profiles", icon: "target", text: "Who you want to work with. Drives the Fit score." },
    { slug: "suppressions", title: "Suppressions", icon: "ban", text: "Clients, competitors and opt-outs that never get drafted." },
    { slug: "scores", title: "How scores work", icon: "zap", text: "Plain-English guide to lead score, site health, fit and urgency." },
  ] },
  { name: "Account", tint: "plain", cards: [
    { slug: "google", title: "Google", icon: "link", text: "Gmail drafts and Drive. Nothing is ever sent." },
    { slug: "usage", title: "Usage & limits", icon: "card", text: "Monthly spend limit and what each service cost." },
    { slug: "footer", title: "Mailing footer", icon: "shield", text: "Mailing address and opt-out line for freelance emails." },
  ] },
];

/** Settings: the overview. A card per page with its real status, and a banner for what is still missing. */
export default function SettingsHome() {
  const [d, setD] = useState<Data>({ doc: null, usage: [], samples: null, services: null, fits: null, supps: null, google: null });
  useEffect(() => {
    let live = true;
    const part = <T,>(p: Promise<T>, apply: (v: T | false) => void) => p.then((v) => live && apply(v)).catch(() => live && apply(false));
    void part(api.get<{ settings: SettingsDoc; usage: UsageRow[] }>("/settings"), (v) => setD((o) => ({ ...o, doc: v && v.settings, usage: v ? v.usage : [] })));
    void part(api.get<WorkSample[]>("/work-samples"), (v) => setD((o) => ({ ...o, samples: v })));
    void part(api.get<Service[]>("/services"), (v) => setD((o) => ({ ...o, services: v })));
    void part(api.get<FitProfile[]>("/fit-profiles"), (v) => setD((o) => ({ ...o, fits: v })));
    void part(api.get<Suppression[]>("/suppressions"), (v) => setD((o) => ({ ...o, supps: v })));
    void part(api.get<Google>("/google/status"), (v) => setD((o) => ({ ...o, google: v })));
    return () => { live = false; };
  }, []);
  const status = chips(d);
  const ready = d.doc && d.samples && d.services;
  const items = ready ? setupItems({ doc: d.doc as SettingsDoc, samples: d.samples as WorkSample[], services: d.services as Service[] }) : [];
  const todo = items.filter((i) => !i.done);
  const next = todo.filter((i, n) => todo.findIndex((o) => o.to === i.to) === n).slice(0, 2).reverse();
  return (
    <SettingsPage title="Settings" sub="Everything that shapes your drafts, your scores and your shared reports." width={1078}>
      <div className="sh-wrap">
        {ready && (
          <section className="sh-banner" aria-label="Setup progress">
            <span className="sh-ring" aria-label={`${items.length - todo.length} of ${items.length} done`}>{items.length - todo.length}/{items.length}</span>
            <div className="txt">
              <h2>{todo.length ? "Finish setting up for better drafts" : "Drafts have everything they need"}</h2>
              <p>{todo.length ? setupSentence(items, d.samples as WorkSample[]) : "Your profile, signature, work samples and services are all set."}</p>
            </div>
            {todo.length > 0 && <div className="acts">{next.map((i, n) => <Link key={i.key} to={i.to} className={`btn${n === next.length - 1 ? " primary" : ""}`}>{i.action}</Link>)}</div>}
          </section>
        )}
        {SECTIONS.map((sec) => (
          <section key={sec.name} className="sh-sec" aria-label={sec.name}>
            <h3>{sec.name}</h3>
            <div className="sh-grid">
              {sec.cards.map((c) => {
                const chip = status[c.slug];
                return (
                  <Link key={c.slug} to={`/settings/${c.slug}`} className="sh-card">
                    <div className="sh-top"><span className={`sh-tile t-${sec.tint}`}><Icon name={c.icon} size={17} /></span><h4>{c.title}</h4><Icon name="chevron-right" size={16} className="chev" /></div>
                    <p>{c.text}</p>
                    {chip ? <span className={`badge2${chip.tone ? ` ${chip.tone}` : ""}`}><i className="dot" />{chip.text}</span> : <span className="badge2 sk" aria-hidden="true">&nbsp;</span>}
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </SettingsPage>
  );
}
