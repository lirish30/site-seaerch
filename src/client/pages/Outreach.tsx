import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import Icon from "../components/Icon";
import { announceLeadsChanged } from "../components/Shell";
import { Badge, LeadScore } from "../components/Score";
import { PURPOSE_LABEL, snippet, type Draft } from "../emailView";
import { initials } from "../scoreView";
import type { LeadRow, OutreachCounts, OutreachView } from "../types";

interface Item { row: LeadRow; draft: Draft | null }
const SORTS = [["best", "Best leads first"], ["newest", "Newest first"], ["oldest", "Oldest first"]] as const;
type Sort = (typeof SORTS)[number][0];
const TITLE: Record<OutreachView, string> = { drafts: "Drafts ready", followups: "Follow-ups due", contacted: "Contacted", replied: "Replied" };
const EMPTY: Record<OutreachView, string> = {
  drafts: "No drafts waiting. Open a lead and write an email, and it will queue up here.",
  followups: "No follow-ups are due. Set a follow-up date on a lead to see it here.",
  contacted: "Nobody is waiting on a reply yet.", replied: "No replies logged yet.",
};
const DAY = 86_400_000;
/** "2d", "Today": how long ago the draft was written, for the list. */
const age = (iso: string | undefined, now = Date.now()) => { if (!iso) return null; const d = Math.floor((now - Date.parse(iso)) / DAY); return { days: d, label: d <= 0 ? "Today" : `${d}d` }; };
const paragraphs = (body: string) => body.split(/\n{2,}/).filter((p) => p.trim());

/** Every unsent draft in one place: a list on the left, the email on the right, and the three things you do with it. */
export default function Outreach() {
  const [sp] = useSearchParams();
  const view = (["drafts", "followups", "contacted", "replied"].includes(sp.get("view") ?? "") ? sp.get("view") : "drafts") as OutreachView;
  const purpose = sp.get("purpose");
  const [items, setItems] = useState<Item[] | null>(null);
  const [counts, setCounts] = useState<OutreachCounts | null>(null);
  const [err, setErr] = useState("");
  const [sort, setSort] = useState<Sort>("best");
  const [picked, setPicked] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setErr("");
    api.get<{ counts: OutreachCounts; items: Item[] }>(`/outreach?view=${view}${purpose ? `&purpose=${purpose}` : ""}`)
      .then((r) => { if (!cancelled) { setItems(r.items); setCounts(r.counts); } })
      .catch((e) => { if (!cancelled) setErr(e instanceof ApiError ? e.message : "Couldn't load your drafts."); });
    return () => { cancelled = true; };
  }, [view, purpose, reloads]);
  useEffect(() => { setPicked(null); setSkipped(new Set()); setNote(""); }, [view, purpose]);

  const sorted = useMemo(() => {
    const list = [...(items ?? [])].filter((i) => !skipped.has(i.row.business.id));
    const at = (i: Item) => Date.parse(i.draft?.created_at ?? i.row.business.created_at);
    const by: Record<Sort, (a: Item, b: Item) => number> = {
      best: (a, b) => (b.row.score ?? -1) - (a.row.score ?? -1), newest: (a, b) => at(b) - at(a), oldest: (a, b) => at(a) - at(b),
    };
    return list.sort(by[sort]).concat((items ?? []).filter((i) => skipped.has(i.row.business.id)));
  }, [items, sort, skipped]);
  const current = sorted.find((i) => i.row.business.id === picked) ?? sorted[0] ?? null;
  const index = current ? sorted.indexOf(current) : -1;

  const reload = useCallback(() => { setReloads((n) => n + 1); announceLeadsChanged(); }, []);
  const next = (from: Item | null) => { const i = from ? sorted.indexOf(from) : -1; setPicked(sorted[i + 1]?.row.business.id ?? sorted[Math.max(0, i - 1)]?.row.business.id ?? null); };

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name); setNote(""); setErr("");
    try { await fn(); } catch (e) { setErr(e instanceof ApiError ? e.message : (e as Error).message || "That didn't work."); } finally { setBusy(""); }
  }
  const gmail = (it: Item) => run("gmail", async () => {
    await api.post(`/leads/${it.row.business.id}/gmail-draft`, { attachReport: true });
    setNote("Saved to your Gmail drafts. It hasn't been sent.");
  });
  const copyMark = (it: Item) => run("copy", async () => {
    const d = it.draft; if (!d) return;
    const c = await api.post<{ text: string }>(`/leads/${it.row.business.id}/draft/preview`, { subject: d.subject, body: d.body, include_footer: d.include_footer });
    await navigator.clipboard.writeText(`Subject: ${d.subject}\n\n${c.text}`);
    await api.patch(`/leads/${it.row.business.id}`, { leadStatus: "contacted" });
    next(it); reload(); setNote("Copied and marked contacted.");
  });

  return (
    <div className="outreach">
      <section className="o-list" aria-label={TITLE[view]}>
        <header className="o-list-head">
          <h1>{purpose ? PURPOSE_LABEL[purpose as "full_time" | "freelance"] ?? TITLE[view] : TITLE[view]}</h1>
          <label className="sort"><select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort drafts">{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select><Icon name="chevron-down" size={12} /></label>
        </header>
        <div className="o-items">
          {items === null && !err && <p className="o-empty">Loading…</p>}
          {items && sorted.length === 0 && <p className="o-empty">{EMPTY[view]}</p>}
          {sorted.map((it) => {
            const b = it.row.business, a = age(it.draft?.created_at ?? undefined);
            return (
              <button key={b.id} className={`o-item${current?.row.business.id === b.id ? " on" : ""}`} onClick={() => setPicked(b.id)} aria-current={current?.row.business.id === b.id ? "true" : undefined}>
                <span className="o-top"><b>{b.name}</b>{a && <time className={a.days >= 6 ? "late" : undefined} dateTime={it.draft?.created_at}>{a.label}</time>}</span>
                <span className="o-sub">{it.draft?.subject ?? (it.row.topFinding ?? "No draft yet")}</span>
                <span className="o-snip">{it.draft ? snippet(it.draft.body.replace(/^\s*(hi|hello|hey|dear)\b[^\n]{0,40},?\s*\n+/i, ""), 70) : "Follow-up due. Open the lead to write an email."}</span>
                <span className="o-tags"><LeadScore score={it.row.score} />{it.draft && <Badge tone="outline">{it.draft.purpose === "full_time" ? "Full-time" : "Freelance"}</Badge>}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="o-read" aria-label="Draft">
        {current ? <Reading it={current} index={index} total={sorted.length} counts={counts} view={view} busy={busy} note={note} err={err}
          onGmail={() => void gmail(current)} onCopy={() => void copyMark(current)} onSkip={() => { setSkipped((s) => new Set(s).add(current.row.business.id)); next(current); }} />
          : <div className="o-none"><Icon name="mail" size={20} /><p>{err || (items ? EMPTY[view] : "Loading…")}</p></div>}
      </section>
    </div>
  );
}

function Reading({ it, index, total, view, busy, note, err, onGmail, onCopy, onSkip }: {
  it: Item; index: number; total: number; counts: OutreachCounts | null; view: OutreachView; busy: string; note: string; err: string;
  onGmail: () => void; onCopy: () => void; onSkip: () => void;
}) {
  const { row, draft } = it, b = row.business;
  const ago = draft ? age(draft.created_at) : null;
  const to = row.poc ? `${row.poc.name} · ${row.poc.email ?? row.bestContact ?? "no email yet"}` : row.bestContact ?? "No contact found yet";
  const sub = [b.category, b.address, draft && ago ? `draft written ${ago.days <= 0 ? "today" : `${ago.days} ${ago.days === 1 ? "day" : "days"} ago`}` : null].filter(Boolean).join(" · ");
  return (
    <>
      <header className="o-head">
        <span className="avatar-md" aria-hidden="true">{initials(b.name)}</span>
        <div className="o-title"><h2>{b.name}<LeadScore score={row.score} /></h2><p>{sub}</p></div>
        <Link className="btn" to={`/leads/${b.id}`}><Icon name="arrow-up-right" size={16} />Open lead</Link>
      </header>
      {draft ? (
        <>
          <div className="o-meta">
            <p><span>To</span>{to}</p>
            <p><span>Subject</span><b>{draft.subject}</b></p>
            <p><span>Purpose</span>{PURPOSE_LABEL[draft.purpose]}</p>
          </div>
          <div className="o-body">
            <div className="o-text">{paragraphs(draft.body).map((p, i) => <p key={i}>{p}</p>)}</div>
            {draft.angle.trim() && <p className="o-built"><Icon name="sparkles" size={14} />Angle: {draft.angle}</p>}
            {err && <p className="error" role="alert">{err}</p>}
            {note && <p className="muted small" role="status">{note}</p>}
          </div>
        </>
      ) : (
        <div className="o-body">
          <div className="o-text"><p className="muted">There's no draft for this lead yet.</p></div>
          {err && <p className="error" role="alert">{err}</p>}
        </div>
      )}
      <footer className="o-foot">
        <Link className="btn" to={`/leads/${b.id}?tab=email`}><Icon name="pen" size={16} />{draft ? "Edit" : "Write email"}</Link>
        <button className="btn-plain" onClick={onSkip} disabled={total < 2}><Icon name="clock" size={16} />Skip for now</button>
        <span className="grow" />
        <span className="o-count">{index + 1} of {total}</span>
        {draft && <button className="btn" onClick={onGmail} disabled={busy !== ""}><Icon name="mail" size={16} />{busy === "gmail" ? "Saving…" : "Create Gmail draft"}</button>}
        {draft && view !== "contacted" && view !== "replied" && <button className="btn primary" onClick={onCopy} disabled={busy !== ""}><Icon name="check" size={16} />{busy === "copy" ? "Copying…" : "Copy & mark contacted"}</button>}
      </footer>
    </>
  );
}
