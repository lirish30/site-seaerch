import { useRef, useState } from "react";
import Icon from "../../components/Icon";
import { checkFile, dueLabel, FILE_ACCEPT, formatBytes, itemStateLabel, MAX_FILES_PER_ITEM, type PublicOnboardingItem } from "../../onboardView";
import type { OnboardApi, SavedFile } from "./api";
import type { PageHooks } from "./Questionnaire";
import SaveNote from "./SaveNote";
import { useSaver } from "./useSaver";

interface Props { item: PublicOnboardingItem; api: OnboardApi; now: Date; timezone: string; readOnly: boolean; hooks: PageHooks }

function TextBox({ item, api, hooks }: { item: PublicOnboardingItem; api: OnboardApi; hooks: PageHooks }) {
  const [text, setText] = useState(item.textValue ?? "");
  const saver = useSaver<string>({
    send: (v) => api.saveText(item.id, v),
    onSaved: hooks.onSaved, onLocked: hooks.onLocked, onGone: hooks.onGone,
  });
  const left = 5000 - text.length;
  return (
    <div className="ob-field">
      <label htmlFor={`t-${item.id}`} className="ob-sr">{item.label}</label>
      <textarea id={`t-${item.id}`} rows={6} maxLength={5000} value={text} autoComplete="off" placeholder="Type here"
        onChange={(e) => { setText(e.target.value); saver.schedule(e.target.value); }} onBlur={() => void saver.flush()} />
      <SaveNote state={saver.state} onRetry={() => void saver.flush()} />
      {left < 500 && <p className="ob-fine">{left} characters left</p>}
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
    <div className="ob-files">
      {files.length > 0 && (
        <ul className="ob-filelist">
          {files.map((f) => (
            <li key={f.id}>
              <span className="ob-fname">{f.fileName}</span>
              <span className="ob-fsize">{formatBytes(f.sizeBytes)}</span>
              {!readOnly && <button type="button" className="btn sm ob-remove" disabled={!!busy} aria-label={`Remove ${f.fileName}`} onClick={() => void remove(f)}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="ob-pick">
          <input ref={input} type="file" multiple hidden accept={FILE_ACCEPT} onChange={(e) => void add(e.target.files)} tabIndex={-1} />
          <button type="button" className="btn" disabled={!!busy || files.length >= MAX_FILES_PER_ITEM} onClick={() => input.current?.click()}><Icon name="upload" size={16} />{files.length ? "Add more files" : "Choose files"}</button>
          <span className="ob-fine">Photos, PDF, Word or text. Up to 20 MB each, {MAX_FILES_PER_ITEM} files.</span>
        </div>
      )}
      {busy && <p className="ob-save" role="status" aria-live="polite">{busy}</p>}
      {problems.length > 0 && <ul className="ob-problems" role="alert">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      {readOnly && files.length === 0 && <p className="ob-fine">No files.</p>}
    </div>
  );
}

/** One thing we asked for. The owner's label and instructions and the client's own text are all shown as React text. */
export default function ItemCard({ item, api, now, timezone, readOnly, hooks }: Props) {
  const done = item.status !== "waiting";
  const locked = readOnly || item.status === "accepted" || item.status === "not_applicable";
  return (
    <li className={`ob-item${done ? " ob-item-done" : ""}`}>
      <div className="ob-item-head">
        <h3>{item.label}</h3>
        <span className={`ob-badge${done ? " ob-badge-done" : ""}`}>{itemStateLabel(item.status)}</span>
      </div>
      {item.status !== "not_applicable" && (
        <>
          <p className="ob-instructions">{item.instructions}</p>
          {item.status === "waiting" && <p className="ob-due">{dueLabel(item.dueAt, now, timezone)}</p>}
          {item.kind === "files"
            ? <FileBox item={item} api={api} hooks={hooks} readOnly={locked} />
            : locked
              ? <p className="ob-sent-text">{item.textValue?.trim() || "Nothing typed."}</p>
              : <TextBox item={item} api={api} hooks={hooks} />}
        </>
      )}
    </li>
  );
}
