import { useEffect, useMemo, useState, type FormEvent } from "react";
import Icon from "../components/Icon";
import { bookingError, cancelPath, dayHeading, formatSlot, groupByDay, safeMeetUrl, timeOfDay, type BookPage, type Booked } from "../bookingView";

type Load = "loading" | "ok" | "gone" | "error";
type Decision = "me" | "me_and_other";

const field = (label: string, input: React.ReactNode, hint?: string) => (
  <label className="bk-field"><span>{label}</span>{input}{hint && <small>{hint}</small>}</label>
);

/** A page that is only a message: link gone, no times, booked, cancelled. */
function Message({ icon, title, children }: { icon: "link" | "alert" | "calendar" | "check"; title: string; children?: React.ReactNode }) {
  return (
    <main className="rp">
      <div className="rp-wrap rp-wrap-narrow">
        <section className="rp-card rp-notice">
          <span className="rp-notice-icon" aria-hidden="true"><Icon name={icon} size={20} /></span>
          <h1>{title}</h1>
          {children}
        </section>
      </div>
    </main>
  );
}

/** What the page tells someone when there is nothing to pick: Calendar is off, or no times are open. */
function NoTimes({ fallbackUrl }: { fallbackUrl: string }) {
  return (
    <Message icon="calendar" title="No times right now">
      <p>Reply to the email you got and we'll find a time that works.</p>
      {fallbackUrl.startsWith("https://") && <a className="btn" href={fallbackUrl} target="_blank" rel="noopener noreferrer">Or pick a time on my calendar</a>}
    </Message>
  );
}

// Public page: deliberately bypasses api.ts, whose 401 handling redirects to /login. Everything a person types is sent as JSON and shown back only
// through React (which escapes it); nothing here renders HTML.
export default function Book({ token }: { token: string }) {
  const zone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);
  const cancelToken = useMemo(() => new URLSearchParams(location.search).get("cancel") ?? "", []);
  const [load, setLoad] = useState<Load>("loading");
  const [page, setPage] = useState<BookPage | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [booked, setBooked] = useState<Booked | null>(null);
  const [start, setStart] = useState("");
  const [name, setName] = useState(""), [email, setEmail] = useState(""), [phone, setPhone] = useState(""), [topic, setTopic] = useState("");
  const [budgetId, setBudgetId] = useState(""), [timeline, setTimeline] = useState(""), [decisionMaker, setDecisionMaker] = useState<Decision>("me");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cancel, setCancel] = useState<"idle" | "busy" | "done" | "failed">("idle");

  useEffect(() => {
    const prevTitle = document.title;
    document.title = "Book a call";
    let meta = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const created = !meta;
    if (!meta) { meta = document.createElement("meta"); meta.name = "robots"; document.head.appendChild(meta); }
    const prevContent = meta.content;
    meta.content = "noindex, nofollow";
    return () => { document.title = prevTitle; if (created) meta.remove(); else meta.content = prevContent; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoad("loading");
    fetch(`/api/public/report/${token}/book`, { credentials: "omit" })
      .then(async (res) => {
        if (res.status === 404) { if (!cancelled) setLoad("gone"); return; }
        const data = (await res.json().catch(() => null)) as (BookPage & { error?: string }) | null;
        if (res.status === 503 && data) { if (!cancelled) { setPage({ enabled: false, fallbackUrl: data.fallbackUrl ?? "", slots: [], tz: "", budgetOptions: [], timelineOptions: [], existing: null }); setLoad("ok"); } return; }
        if (!res.ok || !data) throw new Error(String(res.status));
        if (!cancelled) { setPage(data); setLoad("ok"); setStart((s) => (data.slots.includes(s) ? s : "")); }
      })
      .catch(() => { if (!cancelled) setLoad("error"); });
    return () => { cancelled = true; };
  }, [token, attempt]);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!start || busy) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/public/report/${token}/book`, {
        method: "POST", credentials: "omit", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, ...(phone.trim() && { phone }), topic, budgetId, timeline, decisionMaker, start }),
      });
      const data = (await res.json().catch(() => ({}))) as { booking?: Booked };
      if (res.status === 201 && data.booking) { setBooked(data.booking); return; }
      setError(bookingError(res.status));
      if (res.status === 409) setAttempt((n) => n + 1); // the times changed under them: show what is open now
    } catch { setError(bookingError(0)); }
    finally { setBusy(false); }
  }

  async function doCancel() {
    setCancel("busy");
    try {
      const res = await fetch(`/api/public/report/${token}/book/cancel`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ cancelToken }) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
      setCancel(res.ok && data.ok ? "done" : "failed");
    } catch { setCancel("failed"); }
  }

  if (load === "loading") return <main className="rp" aria-busy="true"><div className="rp-wrap rp-wrap-narrow"><div className="rp-card" role="status" aria-label="Loading"><span className="rp-sk" style={{ height: 28, width: "70%" }} /><span className="rp-sk" style={{ height: 120 }} /></div></div></main>;
  if (load === "error") return (
    <Message icon="alert" title="Couldn't load this page">
      <p>Something went wrong on our side, or your connection dropped. Please try again.</p>
      <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
    </Message>
  );
  if (load === "gone" || !page) return <Message icon="link" title="This link isn't available"><p>It may have expired or been turned off. Reply to the email you got and we'll sort it out.</p></Message>;

  // The cancel link from the email: ask first, then do it.
  if (cancelToken) {
    if (cancel === "done") return <Message icon="check" title="Your call is cancelled"><p>No hard feelings. You can pick another time whenever you like.</p><a className="btn" href={`/r/${token}/book`}>Pick another time</a></Message>;
    return (
      <Message icon="calendar" title="Cancel your call?">
        <p>We'll take it off the calendar. You can book again afterwards.</p>
        {cancel === "failed" && <p className="error" role="alert">We couldn't cancel that. Reply to the email and we'll do it for you.</p>}
        <button type="button" className="btn primary" disabled={cancel === "busy"} onClick={() => void doCancel()}>{cancel === "busy" ? "Cancelling…" : "Cancel this call"}</button>
      </Message>
    );
  }

  if (booked) {
    const meet = safeMeetUrl(booked.meetUrl);
    return (
      <Message icon="check" title="You're booked">
        <p>{formatSlot(booked.start, zone)}, 20 minutes.</p>
        {meet && <a className="btn primary" href={meet} target="_blank" rel="noopener noreferrer"><Icon name="calendar" size={16} />Open the Meet link</a>}
        <p className="bk-small">Need to change it? <a href={cancelPath(token, booked.cancelToken)}>Cancel this call</a> and pick another time. Keep this link.</p>
      </Message>
    );
  }

  if (page.existing) {
    return (
      <Message icon="calendar" title="You already have a call booked">
        <p>{formatSlot(page.existing.start, zone)}. To change it, use the cancel link from your confirmation, then pick another time.</p>
      </Message>
    );
  }

  if (!page.enabled || !page.slots.length) return <NoTimes fallbackUrl={page.fallbackUrl} />;

  const days = groupByDay(page.slots, zone);
  const ready = !!(start && name.trim() && email.trim() && topic.trim() && budgetId && timeline);
  return (
    <main className="rp">
      <div className="rp-wrap rp-wrap-narrow bk-wrap">
        <form className="rp-card" onSubmit={(e) => void submit(e)}>
          <div className="rp-head">
            <p className="rp-eyebrow">Book a call</p>
            <h1>Pick a time for a 20-minute call</h1>
            <p className="rp-based">Times are shown in your time zone ({zone}).</p>
          </div>

          <fieldset className="bk-days">
            <legend>Choose a time</legend>
            {days.map((d) => (
              <div key={d.day} className="bk-day">
                <h2>{dayHeading(d.slots[0], zone)}</h2>
                <div className="bk-slots">
                  {d.slots.map((s) => (
                    <button key={s} type="button" className="bk-slot" aria-pressed={start === s} onClick={() => setStart(s)}>{timeOfDay(s, zone)}</button>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>

          <div className="bk-form">
            {field("Your name", <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="name" required />)}
            {field("Email", <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="email" required />)}
            {field("Phone (optional)", <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} autoComplete="tel" />)}
            {field("What would you like to talk about?", <textarea value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={500} rows={3} required />)}
            {field("Rough budget", (
              <select value={budgetId} onChange={(e) => setBudgetId(e.target.value)} required>
                <option value="" disabled>Choose one</option>
                {page.budgetOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            ))}
            {field("When do you want this done?", (
              <select value={timeline} onChange={(e) => setTimeline(e.target.value)} required>
                <option value="" disabled>Choose one</option>
                {page.timelineOptions.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ))}
            <fieldset className="bk-radio">
              <legend>Who decides on this?</legend>
              <label><input type="radio" name="dm" checked={decisionMaker === "me"} onChange={() => setDecisionMaker("me")} />Just me</label>
              <label><input type="radio" name="dm" checked={decisionMaker === "me_and_other"} onChange={() => setDecisionMaker("me_and_other")} />Me and someone else</label>
            </fieldset>
          </div>

          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="btn primary bk-submit" disabled={!ready || busy}><Icon name="calendar" size={16} />{busy ? "Booking…" : start ? `Book ${timeOfDay(start, zone)}` : "Pick a time"}</button>
        </form>
      </div>
    </main>
  );
}
