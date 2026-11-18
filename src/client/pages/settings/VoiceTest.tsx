import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import SettingsPage, { Callout, Card, Field } from "../../components/SettingsPage";
import { Toggle } from "../../components/settingsBits";
import { useSettingsDoc } from "../../settingsData";
import { RECORD_OWN_STEPS, engineName, referenceProblem, voiceTestLine } from "../../voiceTestView";

interface Clip { label: "A" | "B" | "C"; url: string; status: "ready" | "pending" | "failed"; error?: string }
interface Test { id: string; chosen: "A" | "B" | "C" | null; pending: number; helperOnline: boolean; clips: Clip[]; engines?: Record<string, string> }
interface Voice { voice_engine: string | null; voice_ref_key: string | null }

const RECORD_TYPE = "audio/webm";
const canRecord = () => typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia && MediaRecorder.isTypeSupported(RECORD_TYPE);

/** How long a recording runs, from the audio itself. A MediaRecorder file carries no length in its header, so the file is decoded. */
async function measureMs(blob: Blob): Promise<number> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return NaN;
  const ctx = new Ctx();
  try { return Math.round((await ctx.decodeAudioData(await blob.arrayBuffer())).duration * 1000); }
  catch { return NaN; }
  finally { void ctx.close(); }
}

/** Settings > Video voice: the reference recording, the blind A/B test between the three cloning engines, and what a video says about its voice and where it sends people. */
export default function VoiceTest() {
  const doc = useSettingsDoc();
  const [voice, setVoice] = useState<Voice | null | false>(null);
  const [test, setTest] = useState<Test | null | false>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [refMsg, setRefMsg] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [refStamp, setRefStamp] = useState(0);
  const [none, setNone] = useState(false);
  const rec = useRef<{ recorder: MediaRecorder; chunks: Blob[]; started: number; timer: ReturnType<typeof setInterval> } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; if (rec.current) { clearInterval(rec.current.timer); rec.current.recorder.stream.getTracks().forEach((t) => t.stop()); } }, []);

  const loadVoice = useCallback(() => { api.get<{ settings: Voice }>("/settings").then((r) => alive.current && setVoice(r.settings)).catch(() => alive.current && setVoice(false)); }, []);
  const loadTest = useCallback(() => { api.get<{ test: Test | null }>("/voice-tests/latest").then((r) => alive.current && setTest(r.test)).catch(() => alive.current && setTest(false)); }, []);
  useEffect(() => { loadVoice(); loadTest(); }, [loadVoice, loadTest]);
  // While the Mac is still making clips, look again every few seconds.
  const waiting = !!test && test.chosen === null && test.clips.some((c) => c.status === "pending");
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(loadTest, 5000);
    return () => clearInterval(t);
  }, [waiting, loadTest]);

  async function sendReference(blob: Blob, type: string, ms: number) {
    const problem = referenceProblem(ms);
    if (problem) { setRefMsg(problem); return; }
    setBusy(true); setRefMsg("");
    try {
      await api.putRaw("/settings/voice-reference", blob, { "content-type": type, "x-duration-ms": String(ms) });
      setRefStamp(Date.now()); loadVoice();
    } catch (e) { setRefMsg(e instanceof ApiError ? e.message : "The recording didn't save. Try again."); }
    if (alive.current) setBusy(false);
  }
  async function pickFile(file: File | undefined) {
    if (!file) return;
    setRefMsg("");
    await sendReference(file, file.type || "audio/wav", await measureMs(file));
  }
  async function startRecording() {
    setRefMsg("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: RECORD_TYPE });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const started = performance.now();
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (alive.current) void sendReference(new Blob(chunks, { type: RECORD_TYPE }), RECORD_TYPE, Math.round(performance.now() - started));
      };
      const timer = setInterval(() => setSeconds(Math.round((performance.now() - started) / 1000)), 500);
      rec.current = { recorder, chunks, started, timer };
      setSeconds(0); setRecording(true);
      recorder.start();
    } catch { setRefMsg("The microphone isn't available. Allow it for this site and try again."); }
  }
  function stopRecording() {
    if (!rec.current) return;
    clearInterval(rec.current.timer); rec.current.recorder.stop(); rec.current = null; setRecording(false);
  }

  async function act(run: () => Promise<unknown>, fallback: string) {
    setBusy(true); setMsg("");
    try { await run(); } catch (e) { setMsg(e instanceof ApiError ? e.message : fallback); }
    if (alive.current) setBusy(false);
  }
  const start = () => act(async () => { await api.post("/voice-tests"); setNone(false); loadTest(); }, "Couldn't start the test.");
  const choose = (label: string) => act(async () => { await api.post(`/voice-tests/${test && test.id}/choose`, { label }); setNone(false); loadTest(); loadVoice(); }, "Couldn't save your pick.");
  const noneOfThese = () => act(async () => { await api.post("/voice-tests/none"); setNone(true); loadVoice(); }, "Couldn't save that.");

  const hasRef = !!voice && !!voice.voice_ref_key;
  const t = test || null;
  const ready = !!t && t.clips.every((c) => c.status === "ready");
  const failed = t ? t.clips.filter((c) => c.status === "failed") : [];
  // With no cloned voice and no test under way, say how to narrate the lines yourself.
  const ownLines = !!voice && !voice.voice_engine && (none || !t);

  return (
    <SettingsPage title="Video voice" width={720} doc={doc}
      sub="Your videos can speak in a clone of your voice. Record yourself once, then listen to three engines read the same line and pick the one that sounds most like you. You don't see which is which until you choose.">
      <Card title="Your reference recording" sub="Talk naturally for 30 seconds to 2 minutes, in a quiet room. The three engines copy the voice they hear here.">
        {voice === false && <Callout tone="critical" icon="alert">Couldn't load your settings.</Callout>}
        {hasRef && <p className="vt-ref"><audio controls src={`/api/settings/voice-reference?v=${refStamp}`} aria-label="Your reference recording" /></p>}
        {voice && !hasRef && <p className="st-loading">No reference recording yet.</p>}
        <div className="vt-actions">
          {recording
            ? <button type="button" className="btn danger-ghost" onClick={stopRecording}>Stop and save ({seconds}s)</button>
            : <button type="button" className="btn" disabled={busy || !canRecord()} onClick={() => void startRecording()}>{hasRef ? "Record again" : "Record now"}</button>}
          <label className={`btn${busy || recording ? " disabled" : ""}`}>
            Upload a file
            <input type="file" accept="audio/wav,audio/webm,audio/mpeg,audio/mp4,audio/x-m4a,.wav,.webm,.mp3,.m4a" hidden disabled={busy || recording}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void pickFile(f); }} />
          </label>
        </div>
        {!canRecord() && <p className="help">This browser can't record. Use Chrome or Edge, or upload a wav, mp3 or m4a file (up to 15 MB).</p>}
        {refMsg && <p className="help err" role="alert">{refMsg}</p>}
      </Card>

      <Card title="Voice test" sub="The same line, read three ways.">
        {test === false && <Callout tone="critical" icon="alert">Couldn't load the test.</Callout>}
        {!t && test !== false && <p className="st-loading">{test === null ? "Loading…" : "No test yet."}</p>}
        {t && (
          <>
            <p className="vt-line" role="status">{voiceTestLine({ pending: t.pending, chosen: t.chosen })}</p>
            {!t.helperOnline && t.chosen === null && t.pending > 0 && <Callout tone="warn" icon="alert">Your Mac helper is offline. Start it and the clips will appear here.</Callout>}
            {failed.length > 0 && <Callout tone="critical" icon="alert">{failed[0].error ?? "A clip couldn't be made."} Run the test again.</Callout>}
            <ul className="st-list vt-clips">
              {t.clips.map((c) => (
                <li key={c.label} className="st-list-row">
                  <div className="vt-clip">
                    <b>{c.label}{t.engines ? ` · ${engineName(t.engines[c.label])}` : ""}{t.chosen === c.label ? " · your pick" : ""}</b>
                    {c.status === "ready" ? <audio controls preload="none" src={c.url} aria-label={`Clip ${c.label}`} /> : <span>{c.status === "failed" ? "Couldn't be made" : "Waiting for your Mac"}</span>}
                  </div>
                  {t.chosen === null && <button type="button" className="btn" disabled={busy || !ready} onClick={() => void choose(c.label)}>This one</button>}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="vt-actions">
          <button type="button" className={`btn${!t ? " primary" : ""}`} disabled={busy || !hasRef} onClick={() => void start()}>{t ? "Run a new test" : "Run the test"}</button>
          <button type="button" className="btn-plain" disabled={busy} onClick={() => void noneOfThese()}>None of these: I'll record my own</button>
        </div>
        {!hasRef && <p className="help">Add a reference recording first.</p>}
        {msg && <p className="help err" role="alert">{msg}</p>}
        {voice && voice.voice_engine && <p className="help">New videos use the cloned voice ({engineName(voice.voice_engine)}).</p>}
        {voice && !voice.voice_engine && <p className="help">No cloned voice is set. New videos are narrated from your own recordings.</p>}
        {ownLines && (
          <Callout icon="info">
            Recording your own lines:
            <ol>{RECORD_OWN_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
          </Callout>
        )}
      </Card>

      <Card title="In your videos">
        <Field label="Booking link" htmlFor="vt-book" error={doc.errors.booking_url} help="Where a video sends people to book a call. An https:// link, or leave it empty.">
          <input id="vt-book" type="url" inputMode="url" maxLength={500} placeholder="https://cal.com/you" value={doc.value("booking_url")} onChange={(e) => doc.set("booking_url", e.target.value)} />
        </Field>
        <div className="vt-note">
          <div><b>Say the voice is AI</b><span>A short note on the video's page that the voice is a clone of yours. Leave it on unless you narrate every video yourself.</span></div>
          <Toggle checked={doc.value("ai_voice_note") !== "0"} onChange={(v) => doc.set("ai_voice_note", v ? 1 : 0)} label="Say the voice is AI" />
        </div>
      </Card>
    </SettingsPage>
  );
}
