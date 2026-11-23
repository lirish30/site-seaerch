import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import Icon from "../components/Icon";
import { PubBar, PubError, PubGone, PubNotice, PubSkeleton, Tile, useNoIndex } from "../components/PublicPage";
import { bookingError, cancelPath, cancelledCopy, dayHeading, formatSlot, groupByDay, safeMeetUrl, timeOfDay, type BookPage, type Booked } from "../bookingView";

type Load = "loading" | "ok" | "gone" | "error";
type Decision = "me" | "me_and_other";

const KIND = "Book a call";

const field = (label: string, input: ReactNode, o: { hint?: string; wide?: boolean } = {}) => (
  <label className={`deal-field${o.wide ? " wide" : ""}`}><span>{label}</span>{input}{o.hint && <small>{o.hint}</small>}</label>
);

/** What the page tells someone when there is nothing to pick: Calendar is off, or no times are open. */
function NoTimes({ fallbackUrl }: { fallbackUrl: string }) {
  return (
    <PubNotice kind={KIND} icon="calendar" title="No times right now">
      <p>Reply to the email you got and we'll find a time that works.</p>
      {fallbackUrl.startsWith("https://") && <a className="btn" href={fallbackUrl} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} />Or pick a time on my calendar</a>}
    </PubNotice>
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
  const [cancelledKind, setCancelledKind] = useState("");
  useNoIndex("Book a call");

  useEffect(() => {
    let cancelled = false;
    // The cancel link never needs the page's data (and the report link may have expired since): it goes straight to its own confirm step.
    if (cancelToken) { setLoad("ok"); return; }
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
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; kind?: string };
      if (res.ok && data.ok) setCancelledKind(data.kind ?? "");
      setCancel(res.ok && data.ok ? "done" : "failed");
    } catch { setCancel("failed"); }
  }

  // The cancel link from the email: ask first (opening the link only shows this; a mail scanner that fetches it cancels nothing), then do it.
  if (cancelToken) {
    if (cancel === "done") {
      const copy = cancelledCopy(cancelledKind);
      return <PubNotice kind={KIND} icon="check" tone="positive" title={copy.title}><p>{copy.body}</p>{copy.rebook && <a className="btn primary" href={`/r/${token}/book`}><Icon name="calendar" size={16} />Pick another time</a>}</PubNotice>;
    }
    return (
      <PubNotice kind={KIND} icon="calendar" tone="warning" title="Cancel your call?">
        <p>We'll take it off the calendar. You can book again afterwards.</p>
        {cancel === "failed" && <p className="pbx-error" role="alert">We couldn't cancel that. Reply to the email and we'll do it for you.</p>}
        <button type="button" className="btn primary" disabled={cancel === "busy"} onClick={() => void doCancel()}>{cancel === "busy" ? "Cancelling…" : "Cancel this call"}</button>
      </PubNotice>
    );
  }

  if (load === "loading") return <PubSkeleton kind={KIND} label="Loading" two />;
  if (load === "error") return <PubError kind={KIND} what="this page" onRetry={() => setAttempt((n) => n + 1)} />;
  if (load === "gone" || !page) return <PubGone kind={KIND} />;

  if (booked) {
    const meet = safeMeetUrl(booked.meetUrl);
    return (
      <PubNotice kind={KIND} icon="check" tone="positive" title="You're booked">
        <p><b style={{ color: "var(--text)", fontWeight: 500 }}>{formatSlot(booked.start, zone)}</b>, 20 minutes.</p>
        {meet && <a className="btn primary" href={meet} target="_blank" rel="noopener noreferrer"><Icon name="calendar" size={16} />Open the Meet link</a>}
        <p className="pbx-fine">Need to change it? <a href={cancelPath(token, booked.cancelToken)}>Cancel this call</a> and pick another time. Keep this link.</p>
      </PubNotice>
    );
  }

  if (page.existing) {
    return (
      <PubNotice kind={KIND} icon="calendar" tone="info" title="You already have a call booked">
        <p>{formatSlot(page.existing.start, zone)}. To change it, use the cancel link from your confirmation, then pick another time.</p>
      </PubNotice>
    );
  }

  if (!page.enabled || !page.slots.length) return <NoTimes fallbackUrl={page.fallbackUrl} />;

  const days = groupByDay(page.slots, zone);
  const ready = !!(start && name.trim() && email.trim() && topic.trim() && budgetId && timeline);
  const missing = !start ? "Pick a time first." : !name.trim() || !email.trim() || !topic.trim() ? "Add your name, email and what you'd like to talk about." : !budgetId || !timeline ? "Choose a budget and when you want this done." : "";
  return (
    <main className="ds-page pbx">
      <PubBar name={KIND} right={<span className="pbx-bar-meta hide-sm">20-minute video call</span>} />
      <form className="pbx-grid" onSubmit={(e) => void submit(e)}>
        <div className="pbx-col">
          <section className="pbx-card pbx-intro">
            <p className="pbx-eyebrow">Book a call</p>
            <h1>Pick a time for a 20-minute call</h1>
            <p className="pbx-lede">Times are shown in your time zone ({zone}).</p>
          </section>
          <section className="pbx-card tight">
            <div className="pbx-card-head"><Tile icon="clock" tone="signal" /><div><h2>1 · Choose a time</h2><small>{page.slots.length} open {page.slots.length === 1 ? "time" : "times"} over the next {days.length} {days.length === 1 ? "day" : "days"}</small></div></div>
            <fieldset className="pbx-days">
              <legend className="pbx-sr">Choose a time</legend>
              {days.map((d) => (
                <div key={d.day} className="pbx-day">
                  <h3>{dayHeading(d.slots[0], zone)}</h3>
                  <div className="pbx-slots">
                    {d.slots.map((s) => (
                      <button key={s} type="button" className="pbx-slot" aria-pressed={start === s} onClick={() => setStart(s)}>{timeOfDay(s, zone)}</button>
                    ))}
                  </div>
                </div>
              ))}
            </fieldset>
          </section>
        </div>

        <aside className="pbx-card pbx-side tight" aria-label="Your details">
          <div className="pbx-card-head"><Tile icon="user" tone="neutral" /><div><h2>2 · About you</h2><small>So the call is about what matters to you</small></div></div>
          <div className={`pbx-picked${start ? " on" : ""}`}>
            <Tile icon="calendar" tone={start ? "signal" : "neutral"} size={32} />
            <div><b>{start ? formatSlot(start, zone) : "No time picked yet"}</b><small>{start ? "20 minutes, by video" : "Choose one of the open times"}</small></div>
          </div>
          <div className="pbx-form-1">
            {field("Your name", <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="name" required />)}
            {field("Email", <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="email" required />, { hint: "We send your confirmation here." })}
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
            <fieldset className="pbx-radios">
              <legend>Who decides on this?</legend>
              <label className="ds-check"><input type="radio" name="dm" checked={decisionMaker === "me"} onChange={() => setDecisionMaker("me")} /><span>Just me</span></label>
              <label className="ds-check"><input type="radio" name="dm" checked={decisionMaker === "me_and_other"} onChange={() => setDecisionMaker("me_and_other")} /><span>Me and someone else</span></label>
            </fieldset>
          </div>
          {error && <p className="pbx-error" role="alert">{error}</p>}
          <button type="submit" className="btn primary pbx-go" disabled={!ready || busy}><Icon name="calendar" size={16} />{busy ? "Booking…" : start ? `Book ${timeOfDay(start, zone)}` : "Pick a time"}</button>
          {!ready && missing && <p className="pbx-fine">{missing}</p>}
        </aside>
      </form>
    </main>
  );
}
