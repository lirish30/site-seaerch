import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import Icon from "../components/Icon";
import { Banner, Card, Chip, Empty, Facts, Note, PageHeader, Seg } from "../components/ds";
import { approvalLink, approvalsLine, canBulkApprove, draftedByLabel, parsePayloadText, whenLabel, type ApprovalItem } from "../approvalsView";
import { useApprovals } from "../approvalsData";
import {
  applyEdits, approveVerb, bucketCounts, bucketTone, bucketInfo, bucketOf, editFields, fieldValues, groupByBucket, heroOf, kindName, isBucket, neighbours, oneByOneReason, previewParts, rowLine, shortWhen, type Bucket, type BucketGroup,
} from "../approvalsInbox";

/**
 * Approvals (Figma 58:3999 inbox, 58:4450 edit & approve). Everything drafted for a client or prospect waits here until you approve it.
 * /approvals lists it, filtered by ?kind=<bucket>; /approvals?id=<id> opens one to read, edit (where its kind carries words) and approve or reject.
 */
type Order = "oldest" | "newest";
type Data = ReturnType<typeof useApprovals>;
type Go = (n: { id?: string | null; kind?: string | null }) => void;

const drafter = (d: ApprovalItem["drafted_by"]) =>
  d === "mcp" ? <Chip tone="signal">Claude</Chip> : d === "logan" ? <Chip tone="outline">You</Chip> : <Chip tone="outline">Automatic</Chip>;
const drafterName = (d: ApprovalItem["drafted_by"]) => (d === "mcp" ? "Claude" : d === "logan" ? "You" : "An automatic job");

export default function Approvals() {
  const data = useApprovals();
  const [params, setParams] = useSearchParams();
  const [order, setOrder] = useState<Order>("oldest");
  const kindParam = params.get("kind");
  const id = params.get("id");

  const all = useMemo(() => data.items ?? [], [data.items]);
  const counts = useMemo(() => bucketCounts(all), [all]);
  const bucket: Bucket | "all" = isBucket(kindParam) && counts.some((c) => c.key === kindParam) ? kindParam : "all";
  const groups = useMemo(() => groupByBucket(bucket === "all" ? all : all.filter((a) => bucketOf(a.kind) === bucket), order), [all, bucket, order]);
  const ids = useMemo(() => groups.flatMap((g) => g.items.map((a) => a.id)), [groups]);

  const go: Go = (next) => {
    const p = new URLSearchParams();
    const k = next.kind === undefined ? (bucket === "all" ? null : bucket) : next.kind;
    if (k) p.set("kind", k);
    if (next.id) p.set("id", next.id);
    setParams(p);
  };

  if (id) return <Detail data={data} item={all.find((a) => a.id === id)} ids={ids} bucket={bucket} go={go} />;
  return <Inbox data={data} groups={groups} counts={counts} bucket={bucket} order={order} setOrder={setOrder} go={go} />;
}

// ---------------------------------------------------------------- inbox

function Inbox({ data, groups, counts, bucket, order, setOrder, go }: {
  data: Data; groups: BucketGroup[]; counts: ReturnType<typeof bucketCounts>; bucket: Bucket | "all";
  order: Order; setOrder: (o: Order) => void; go: Go;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const all = data.items ?? [];
  const n = all.length;
  const visible = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const selected = visible.filter((a) => picked.has(a.id) && canBulkApprove(a.kind));
  const failed = all.filter((a) => a.error || data.errs[a.id]);
  const anyBusy = selected.some((a) => data.busy.has(a.id));

  // Drop picks that have left the list (approved, rejected, filtered away).
  useEffect(() => {
    setPicked((p) => { const keep = new Set([...p].filter((x) => visible.some((a) => a.id === x))); return keep.size === p.size ? p : keep; });
  }, [visible]);

  const toggle = (id: string) => setPicked((p) => { const s = new Set(p); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  const approveSelected = async () => { await data.approveMany(selected); setPicked(new Set()); };

  return (
    <div className="ds-page apx">
      <PageHeader
        title="Approvals"
        sub={data.items ? `${approvalsLine(n)} Nothing reaches a client or prospect until you approve it.` : "Everything waiting for your OK."}
        actions={<>
          <Link to="/settings/auto-approve" className="btn"><Icon name="zap" size={16} />Auto-approve rules</Link>
          {selected.length > 0 && (
            <button type="button" className="btn primary" disabled={anyBusy} onClick={() => void approveSelected()}>
              <Icon name="check" size={16} />Approve {selected.length} selected
            </button>
          )}
        </>}
      />
      <div className="ds-body">
        {!data.items && data.error ? (
          <Banner tone="critical" title="Couldn't load your approvals" action={<button type="button" className="btn sm" onClick={data.reload}>Try again</button>}>{data.error}</Banner>
        ) : !data.items ? (
          <div className="ds-card apx-list" aria-busy="true"><div className="apx-skel" /><div className="apx-skel" /><div className="apx-skel" /></div>
        ) : n === 0 ? (
          <div className="ds-card">
            <Empty icon="inbox" title="You're all caught up"
              action={<Link to="/" className="btn"><Icon name="home" size={16} />Back to Home</Link>}>
              Drafts that need your OK land here: follow-up emails from your sequences, invoices and reminders, monthly reports, proposals,
              video audits, social posts and steps Claude finished. Jobs and Claude add them as they work, and nothing goes out until you approve it.
            </Empty>
          </div>
        ) : (
          <>
            {failed.length > 0 && (
              <Banner tone="critical" title={failed.length === 1 ? "1 approval didn't go through" : `${failed.length} approvals didn't go through`}
                action={<button type="button" className="btn sm" onClick={() => go({ id: failed[0].id, kind: null })}>Open {failed.length === 1 ? "it" : "the first"}</button>}>
                They are still waiting. Open each one to see what went wrong, fix it and approve again.
              </Banner>
            )}
            <div className="apx-toolbar">
              <Seg label="Show" value={bucket} onChange={(k) => go({ kind: k === "all" ? null : k })}
                options={[{ key: "all" as Bucket | "all", label: "Everything", count: n }, ...counts.map((c) => ({ key: c.key as Bucket | "all", label: c.label, count: c.count }))]} />
              <Seg label="Order" value={order} onChange={setOrder} options={[{ key: "oldest", label: "Oldest first" }, { key: "newest", label: "Newest first" }]} />
            </div>
            <section className={`ds-card apx-list${visible.some((a) => canBulkApprove(a.kind)) ? "" : " no-bulk"}`} aria-label="Waiting for your OK">
              {selected.length > 0 && (
                <div className="apx-selbar">
                  <span><Icon name="check" size={14} />{selected.length} selected</span>
                  <button type="button" className="apx-link" onClick={() => setPicked(new Set())}><Icon name="x" size={14} />Clear</button>
                  <span className="apx-grow" />
                  <span className="apx-ghint">Only routine drafts can be picked. The rest open one by one.</span>
                </div>
              )}
              {groups.map((g) => {
                const groupBusy = g.bulk.some((a) => data.busy.has(a.id));
                const mixed = g.bulk.length > 0 && g.bulk.length < g.items.length;
                return (
                  <div key={g.key} role="group" aria-label={g.label}>
                    <div className="apx-ghead">
                      <h2>{g.label} <span>{g.items.length}</span></h2>
                      {g.bulk.length > 0
                        ? <button type="button" className="btn sm apx-ghost" disabled={groupBusy} onClick={() => void data.approveMany(g.bulk)}
                            title={mixed ? "Only the routine ones. The others open one by one." : undefined}>
                            {mixed ? `Approve the ${g.bulk.length} routine` : `Approve all ${g.bulk.length}`}
                          </button>
                        : <span className="apx-ghint">Open each one</span>}
                    </div>
                    <ul>
                      {g.items.map((a) => {
                        const bulk = canBulkApprove(a.kind);
                        return (
                          <Row key={a.id} item={a} bulk={bulk} picked={picked.has(a.id)} onPick={() => toggle(a.id)} busy={data.busy.has(a.id)}
                            error={data.errs[a.id] || a.error || ""} onOpen={() => go({ id: a.id })} onApprove={() => void data.approveOne(a)} />
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </section>
            <Note>Approve all and the quick tick are only for routine drafts. Videos, proposals, invoices, reports and Claude's steps open one by one.</Note>
            {n <= 3 && (
              <section className="apx-what" aria-label="How approvals work">
                <div className="apx-what-card"><span className="ds-tile signal"><Icon name="shield" size={16} /></span><span><b>Nothing goes out without you</b><small>Emails, invoices, reports and posts wait here until you approve them. Reject sends nothing.</small></span></div>
                <div className="apx-what-card"><span className="ds-tile info"><Icon name="pen" size={16} /></span><span><b>Change the words first</b><small>Open one with Review to edit it. What you see is what is sent.</small></span></div>
                <Link to="/settings/auto-approve" className="apx-what-card"><span className="ds-tile positive"><Icon name="zap" size={16} /></span><span><b>Let routine ones through</b><small>Auto-approve rules send the drafts you always OK, so fewer land here.</small></span><Icon name="chevron-right" size={14} className="ds-chev" /></Link>
              </section>
            )}
          </>
        )}
        <div className="sr-only" aria-live="polite" role="status">{all.filter((a) => data.errs[a.id]).map((a) => `${a.title}: ${data.errs[a.id]}`).join(". ")}</div>
      </div>
    </div>
  );
}

function Row({ item, bulk, picked, onPick, busy, error, onOpen, onApprove }: {
  item: ApprovalItem; bulk: boolean; picked: boolean; onPick: () => void; busy: boolean; error: string; onOpen: () => void; onApprove: () => void;
}) {
  const b = bucketInfo(bucketOf(item.kind));
  const line = rowLine(item.preview);
  return (
    <li className={`apx-row${picked ? " picked" : ""}${error ? " failed" : ""}`}>
      {bulk
        ? <input type="checkbox" className="apx-check" checked={picked} onChange={onPick} aria-label={`Select: ${item.title}`} />
        : <span className="apx-check-gap" aria-hidden="true" />}
      <span className={`ds-tile ${error ? "critical" : bucketTone(bucketOf(item.kind))} apx-tile`}><Icon name={b.icon} size={16} /></span>
      <button type="button" className="apx-row-main" onClick={onOpen}>
        <span className="apx-row-title"><b>{item.title}</b><small>{kindName(item.kind, item.label)}</small></span>
        {line && <span className="apx-row-line">{line}</span>}
        {error && <span className="apx-row-err"><Icon name="alert" size={12} />{error}</span>}
      </button>
      <time className="apx-when" dateTime={item.created_at} title={whenLabel(item.created_at)}>{shortWhen(item.created_at)}</time>
      <span className="apx-chip">{error ? <Chip tone="critical" dot>Failed</Chip> : drafter(item.drafted_by)}</span>
      <button type="button" className="btn sm apx-review" onClick={onOpen} aria-label={`Review: ${item.title}`}>Review</button>
      {bulk
        ? <button type="button" className="btn sm apx-tick" disabled={busy} onClick={onApprove} aria-label={`Approve: ${item.title}`} title="Approve as it is"><Icon name="check" size={14} /></button>
        : <span className="apx-tick-gap" aria-hidden="true" />}
    </li>
  );
}

// ---------------------------------------------------------------- edit & approve

function Detail({ data, item, ids, bucket, go }: { data: Data; item: ApprovalItem | undefined; ids: string[]; bucket: Bucket | "all"; go: Go }) {
  const navigate = useNavigate();
  const back = bucket === "all" ? "/approvals" : `/approvals?kind=${bucket}`;
  const crumbLabel = bucket === "all" ? "Everything" : bucketInfo(bucket).label;

  if (!item) {
    return (
      <div className="ds-page apx">
        <PageHeader crumbs={[{ label: "Approvals", to: "/approvals" }]} title="Approval" />
        <div className="ds-body">
          {!data.items && data.error ? (
            <Banner tone="critical" title="Couldn't load your approvals" action={<button type="button" className="btn sm" onClick={data.reload}>Try again</button>}>{data.error}</Banner>
          ) : !data.items ? (
            <div className="ds-card apx-list" aria-busy="true"><div className="apx-skel" /></div>
          ) : (
            <div className="ds-card">
              <Empty icon="check" title="This one is no longer waiting" action={<Link to="/approvals" className="btn">Back to Approvals</Link>}>
                It was approved or rejected already, here or from Home. Anything still waiting is on the Approvals list.
              </Empty>
            </div>
          )}
        </div>
      </div>
    );
  }
  return <DetailBody key={item.id} data={data} item={item} ids={ids} back={back} crumbLabel={crumbLabel} go={go} leaveTo={() => navigate(back)} />;
}

function DetailBody({ data, item, ids, back, crumbLabel, go, leaveTo }: {
  data: Data; item: ApprovalItem; ids: string[]; back: string; crumbLabel: string; go: Go; leaveTo: () => void;
}) {
  const fields = editFields(item.kind);
  const start = useMemo(() => fieldValues(item.kind, item.payload), [item]);
  const [values, setValues] = useState(start);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [localErr, setLocalErr] = useState("");
  const [raw, setRaw] = useState(() => JSON.stringify(item.payload ?? null, null, 2));
  const busy = data.busy.has(item.id);
  const error = data.errs[item.id] || item.error || "";
  const nb = neighbours(ids, item.id);
  const after = nb.next ?? nb.prev;
  const dirty = fields.some((f) => values[f.key] !== start[f.key]);
  const link = approvalLink(item);
  const verb = approveVerb(item.kind);
  const why = canBulkApprove(item.kind) ? "" : oneByOneReason(item.kind);
  const { facts, text } = previewParts(item.preview);
  const hero = heroOf(item.payload);
  const withFooter = !!(item.payload as { includeFooter?: boolean } | null)?.includeFooter;

  const leave = () => { if (after) go({ id: after }); else leaveTo(); };
  const approve = async () => {
    setLocalErr("");
    let payload: unknown = undefined;
    if (fields.length > 0) {
      const r = applyEdits(item.kind, item.payload, values);
      if (!r.ok) { setLocalErr(r.error); return; }
      if (r.changed) payload = r.value;
    }
    if (await data.approveOne(item, payload)) leave();
  };
  const approveRaw = async () => {
    const r = parsePayloadText(raw);
    if (!r.ok) { setLocalErr(r.error); return; }
    setLocalErr("");
    if (await data.approveOne(item, r.value)) leave();
  };
  const reject = async () => { if (await data.rejectOne(item, note)) leave(); };
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  const approveBtn = (
    <button type="button" className="btn primary" disabled={busy} onClick={() => void approve()}>
      <Icon name="check" size={16} />{busy ? "Working…" : verb}
    </button>
  );
  const rejectBtn = (
    <button type="button" className="btn apx-ghost" disabled={busy} onClick={() => setRejecting((r) => !r)} aria-expanded={rejecting}><Icon name="x" size={16} />Reject</button>
  );

  return (
    <div className="ds-page apx">
      <PageHeader
        crumbs={[{ label: "Approvals", to: back }, { label: crumbLabel }]}
        pager={nb.index >= 0 ? { label: `${nb.index + 1} of ${ids.length}`, prev: nb.prev ? () => go({ id: nb.prev }) : undefined, next: nb.next ? () => go({ id: nb.next }) : undefined } : undefined}
        title={item.title}
        chips={<><Chip tone="outline">{kindName(item.kind, item.label)}</Chip>{drafter(item.drafted_by)}</>}
        sub={`${draftedByLabel(item.drafted_by)}, ${whenLabel(item.created_at)}. ${fields.length ? "You can change the words below before you approve." : "Nothing goes out until you approve it."}`}
        actions={<>{rejectBtn}{approveBtn}</>}
      />
      <div className="ds-body">
        {error && <Banner tone="critical" title="The last try didn't go through">{error.replace(/[.\s]*$/, ".")} It is still waiting: fix what it says, then approve again.</Banner>}
        {rejecting && (
          <div className="ds-card apx-reject">
            <label htmlFor="apx-note"><b>Reject this draft</b><small>Nothing is sent. A short note helps the next draft (optional).</small></label>
            <input id="apx-note" type="text" maxLength={500} value={note} placeholder="For example: too pushy, wait until after the call" onChange={(e) => setNote(e.target.value)} />
            <div className="apx-formacts">
              <button type="button" className="btn" disabled={busy} onClick={() => void reject()}>Reject it</button>
              <button type="button" className="btn apx-ghost" disabled={busy} onClick={() => setRejecting(false)}>Cancel</button>
            </div>
          </div>
        )}
        <div className="ds-cols c2 apx-cols">
          <div className="ds-col">
            {item.kind === "email.send" ? (
              <section className="ds-card apx-mail" aria-label="The email">
                {facts.filter((f) => f.label === "From").map((f) => (
                  <div className="apx-mail-row" key="from"><span>From</span><p>{f.value}</p></div>
                ))}
                <label className="apx-mail-row"><span>To</span><input type="email" value={values.to} maxLength={254} onChange={(e) => set("to", e.target.value)} /></label>
                <label className="apx-mail-row"><span>Subject</span><input type="text" value={values.subject} maxLength={200} onChange={(e) => set("subject", e.target.value)} /></label>
                <div className="apx-mail-body">
                  <textarea aria-label="Message" value={values.body} rows={Math.min(22, Math.max(8, values.body.split("\n").length + 2))} onChange={(e) => set("body", e.target.value)} />
                  {hero && (
                    <a className="apx-hero" href={hero.href} target="_blank" rel="noreferrer">
                      <span className="apx-hero-thumb"><Icon name="eye" size={18} /></span>
                      <span className="apx-hero-text"><b>{hero.alt || "Your video audit"}</b><small>{hero.href}</small></span>
                      <Icon name="arrow-up-right" size={14} />
                    </a>
                  )}
                  <p className="apx-foot">Your signature{withFooter ? " and the opt-out footer are" : " is"} added when it sends.</p>
                </div>
                {dirty && <div className="apx-dirty"><Icon name="pen" size={14} /><span>You changed this draft. Approving sends your version.</span><button type="button" className="apx-link" onClick={() => setValues(start)}>Undo my changes</button></div>}
              </section>
            ) : fields.length > 0 ? (
              <Card icon="pen" title="What will be saved" note={dirty ? "Edited" : "You can change this"}>
                <div className="apx-fields">
                  {fields.map((f) => (
                    <label key={f.key} className={`apx-field${f.type === "number" ? " num" : ""}`}>
                      <span>{f.label}{f.optional && <small> (optional)</small>}</span>
                      {f.type === "text"
                        ? <textarea rows={f.max && f.max > 1000 ? 6 : 3} maxLength={f.max} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} />
                        : <input type={f.type === "number" ? "number" : "text"} step={f.type === "number" ? 0.25 : undefined} maxLength={f.max} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} />}
                      {f.hint && <small>{f.hint}</small>}
                    </label>
                  ))}
                  {dirty && <button type="button" className="apx-link" onClick={() => setValues(start)}>Undo my changes</button>}
                </div>
                {item.kind === "ladder.mail" && text && <><p className="apx-sublabel">The mail it goes with</p><pre className="apx-preview">{text}</pre></>}
              </Card>
            ) : (
              <Card icon="file-text" title="What will go out" note="Read only here">
                <div className="apx-doc-head">
                  <span className={`ds-tile ${bucketTone(bucketOf(item.kind))}`}><Icon name={bucketInfo(bucketOf(item.kind)).icon} size={16} /></span>
                  <span><b>{item.title}</b><small>{kindName(item.kind, item.label)} · {drafterName(item.drafted_by)}</small></span>
                </div>
                {facts.length > 0 && <Facts rows={facts.map((f) => ({ label: f.label, value: f.value }))} />}
                <pre className="apx-preview">{text || "No preview for this one."}</pre>
                {link && <Link to={link.to} className="btn apx-open"><Icon name="arrow-up-right" size={16} />{link.label}</Link>}
                <p className="apx-foot">{link ? "To change it, open it, edit it there, then come back to approve." : "This one has no words to edit here. Reject it if it is wrong."}</p>
              </Card>
            )}
            {localErr && <p className="apx-err" role="alert"><Icon name="alert" size={14} />{localErr}</p>}
            <div className="apx-bottom">
              {approveBtn}
              {rejectBtn}
              <span className="apx-grow" />
              {after && <button type="button" className="apx-link" onClick={() => go({ id: after })}>Skip for now<Icon name="chevron-right" size={14} /></button>}
            </div>
            <details className="apx-raw">
              <summary>Advanced: edit the raw data and approve</summary>
              <p>For fixes the boxes above don't cover. This is exactly what gets approved, so keep it valid JSON.</p>
              <textarea rows={8} spellCheck={false} value={raw} onChange={(e) => setRaw(e.target.value)} aria-label="Raw data (JSON)" />
              <button type="button" className="btn sm" disabled={busy} onClick={() => void approveRaw()}>Approve with this data</button>
            </details>
          </div>
          <div className="ds-col">
            <Card icon="info" title="About this">
              <Facts rows={[
                { label: "What", value: kindName(item.kind, item.label) },
                { label: "Drafted by", value: drafterName(item.drafted_by) },
                { label: "Waiting", value: `Since ${whenLabel(item.created_at)}` },
                { label: "In bulk", value: canBulkApprove(item.kind) ? "Can go with Approve all" : "One at a time only" },
              ]} />
            </Card>
            {link && (
              <Card icon="link" title="Where it lives" flush>
                <Link to={link.to} className="ds-link-row"><Icon name="arrow-up-right" size={16} /><span className="ds-link-text"><b>{link.label}</b><small>Opens the record this is about</small></span><Icon name="chevron-right" size={14} className="ds-chev" /></Link>
              </Card>
            )}
            <Card icon="shield" title="Before you approve">
              <ul className="ds-reasons">
                <li className="ok"><Icon name="check" size={14} />{fields.length ? "What you see here is what goes out, with your edits." : "It is read again when you approve, so it uses the latest details."}</li>
                {why && <li><Icon name="info" size={14} />{why}</li>}
                <li><Icon name="info" size={14} />Reject sends nothing. Your note is kept with it.</li>
              </ul>
            </Card>
          </div>
        </div>
        <div className="sr-only" aria-live="polite" role="status">{error}</div>
      </div>
    </div>
  );
}
