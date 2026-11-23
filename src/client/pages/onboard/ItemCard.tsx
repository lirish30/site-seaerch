import { useRef, useState } from "react";
import Icon from "../../components/Icon";
import { Tile } from "../../components/PublicPage";
import { checkFile, dueLabel, FILE_ACCEPT, formatBytes, itemLocked, itemStateLabel, itemTone, MAX_FILES_PER_ITEM, type PublicOnboardingItem } from "../../onboardView";
import type { OnboardApi, SavedFile } from "./api";
import type { PageHooks } from "./Questionnaire";
import SaveNote from "./SaveNote";
import { useSaver } from "./useSaver";

interface Props { item: PublicOnboardingItem; api: OnboardApi; now: Date; timezone: string; readOnly: boolean; hooks: PageHooks; open: boolean }

function TextBox({ item, api, hooks }: { item: PublicOnboardingItem; api: OnboardApi; hooks: PageHooks }) {
  const [text, setText] = useState(item.textValue ?? "");
  const saver = useSaver<string>({
    send: (v, gate) => api.saveText(item.id, v, gate),
    unload: { plan: (s) => api.textUnload(item.id, s), fire: (plan) => api.sendNow(plan, "text") },
    onSaved: hooks.onSaved, onLocked: hooks.onLocked, onGone: hooks.onGone,
  });
  const left = 5000 - text.length;
  return (
    <div className="pbx-col" style={{ gap: 6 }}>
      <label htmlFor={`t-${item.id}`} className="pbx-sr">{item.label}</label>
      <textarea id={`t-${item.id}`} rows={5} maxLength={5000} value={text} autoComplete="off" placeholder="Type here. Rough notes are fine."
        onChange={(e) => { setText(e.target.value); saver.schedule(e.target.value); }} onBlur={() => void saver.flush()} />
      <SaveNote state={saver.state} onRetry={() => void saver.flush()} />
      {left < 500 && <p className="pbx-fine">{left} characters left</p>}
    </div>
  );
}

function FileBox({ item, api, hooks, readOnly }: { item: PublicOnboardingItem; api: OnboardApi; hooks: PageHooks; readOnly: boolean }) {
  const [files, setFiles] = useState<SavedFile[]>(item.files);
  const [busy, setBusy] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  async function add(list: FileList | null) {
    const picked = list ? Array.from(list) : [];
    if (input.current) input.current.value = "";
    if (!picked.length || busy) return;
    const found: string[] = [];
    let count = files.length;
    setProblems([]);
    for (const f of picked) {
      const why = checkFile(f, count);
      if (why) { found.push(why); continue; }
      setBusy(`Uploading ${f.name}...`);
      const { outcome, file } = await api.upload(item.id, f);
      if (outcome.kind === "ok" && file) { count += 1; setFiles((prev) => [...prev, file]); continue; }
      if (outcome.kind === "gone") { hooks.onGone(); break; }
      if (outcome.kind === "locked") { found.push(outcome.message); hooks.onLocked(); break; }
      if (outcome.kind === "ok") { found.push("That file was sent, but we couldn't confirm it. Reload the page to check."); break; }
      found.push(`${f.name.length > 60 ? `${f.name.slice(0, 57)}...` : f.name}: ${outcome.message}`);
      if (outcome.kind === "retry") break;
    }
    setBusy(""); setProblems(found); hooks.onSaved();
  }

  async function remove(f: SavedFile) {
    if (busy) return;
    setBusy("Removing..."); setProblems([]);
    const o = await api.removeFile(f.id);
    if (o.kind === "ok") { setFiles((prev) => prev.filter((x) => x.id !== f.id)); hooks.onSaved(); }
    else if (o.kind === "gone") hooks.onGone();
    else if (o.kind === "locked") { setProblems([o.message]); hooks.onLocked(); }
    else setProblems([o.message]);
    setBusy("");
  }

  return (
    <div className="pbx-files">
      {files.length > 0 && (
        <ul className="pbx-filelist">
          {files.map((f) => (
            <li key={f.id}>
              <Icon name="file-text" size={16} />
              <span className="pbx-fname">{f.fileName}</span>
              <span className="pbx-fsize">{formatBytes(f.sizeBytes)}</span>
              {!readOnly && <button type="button" className="btn sm" disabled={!!busy} aria-label={`Remove ${f.fileName}`} onClick={() => void remove(f)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="pbx-pick">
          <input ref={input} type="file" multiple hidden accept={FILE_ACCEPT} onChange={(e) => void add(e.target.files)} tabIndex={-1} />
          <button type="button" className="btn" disabled={!!busy || files.length >= MAX_FILES_PER_ITEM} onClick={() => input.current?.click()}><Icon name="upload" size={16} />{files.length ? "Add more files" : "Choose files"}</button>
          <span className="pbx-fine">Photos, PDF, Word or text. Up to 20 MB each, {MAX_FILES_PER_ITEM} files.</span>
        </div>
      )}
      {busy && <p className="pbx-save" role="status" aria-live="polite">{busy}</p>}
      {problems.length > 0 && <ul className="pbx-problems" role="alert">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      {readOnly && files.length === 0 && <p className="pbx-fine">No files.</p>}
    </div>
  );
}

const TILE = { waiting: "clock", received: "inbox", accepted: "check", not_applicable: "ban" } as const;

/** One thing we asked for, as a row that opens. The owner's label and instructions and the client's own text are all shown as React text. */
export default function ItemCard({ item, api, now, timezone, readOnly, hooks, open }: Props) {
  // Only the first render decides whether the row starts open: a later refresh must never fold a box someone is typing in.
  const [startOpen] = useState(open);
  const done = item.status !== "waiting";
  const locked = itemLocked(item, readOnly);
  const tone = itemTone(item, now, timezone);
  const due = item.status === "waiting" ? dueLabel(item.dueAt, now, timezone) : null;
  const what = item.kind === "files" ? (item.files.length ? `${item.files.length} ${item.files.length === 1 ? "file" : "files"}` : "Files") : "Text";
  return (
    <li id={`ob-item-${item.id}`}>
      <details className={`pbx-item${done ? " done" : ""}`} open={startOpen}>
        <summary>
          <Tile icon={TILE[item.status] ?? "clock"} tone={tone === "critical" ? "critical" : tone} size={32} />
          <span className="pbx-row-text"><b>{item.label}</b><small>{what}{due ? ` · ${due}` : ""}</small></span>
          <span className={`ds-chip ${tone}`}>{itemStateLabel(item.status)}</span>
          <Icon name="chevron-down" size={16} className="pbx-item-chev" />
        </summary>
        {item.status !== "not_applicable" ? (
          <div className="pbx-item-body">
            <p className="pbx-sub">{item.instructions}</p>
            {item.kind === "files"
              ? <FileBox item={item} api={api} hooks={hooks} readOnly={locked} />
              : locked
                ? <p className="pbx-sent">{item.textValue?.trim() || "Nothing typed."}</p>
                : <TextBox item={item} api={api} hooks={hooks} />}
          </div>
        ) : <div className="pbx-item-body"><p className="pbx-fine">We don't need this one from you.</p></div>}
      </details>
    </li>
  );
}
