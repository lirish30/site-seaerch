import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { Chip } from "../../components/ds";
import Icon from "../../components/Icon";
import SettingsPage, { Callout, Card, Field } from "../../components/SettingsPage";
import { SwitchRow } from "../../components/StepFields";
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

  const badge = voice ? (voice.voice_engine ? <Chip tone="positive" dot>Voice picked · {engineName(voice.voice_engine)}</Chip> : hasRef ? <Chip tone="warning" dot>Run the voice test</Chip> : <Chip tone="outline" dot>Not set up</Chip>) : undefined;

  return (
    <SettingsPage title="Video voice" width={760} doc={doc} badge={badge}
      sub="Your videos can speak in a clone of your voice. Record yourself once, then listen to three engines read the same line and pick the one that sounds most like you. You don't see which is which until you choose.">
      <div className="bx sox">
        <section className="st-card">
          <header><div><h2>1. Your reference recording</h2><p>Talk naturally for 30 seconds to 2 minutes, in a quiet room. The three engines copy the voice they hear here.</p></div></header>
          <ul className="sox-list">
            <li className="sox-row">
              <span className={`sox-tile ${recording ? "critical" : hasRef ? "positive" : ""}`}><Icon name={recording ? "radar" : hasRef ? "check" : "upload"} size={16} /></span>
              <div className="sox-main">
                {voice === false && <b className="bad">Couldn't load your settings.</b>}
                {voice === null && <small>Loading…</small>}
                {recording ? <><b>Recording… {seconds}s</b><small>Stop between 30 seconds and 2 minutes.</small></>
                  : hasRef ? <><b>Recording saved</b><audio controls src={`/api/settings/voice-reference?v=${refStamp}`} aria-label="Your reference recording" /></>
                  : voice && <><b>No reference recording yet</b><small>Record now in the browser, or upload a wav, webm, mp3 or m4a file (up to 15 MB).</small></>}
                {!canRecord() && <small>This browser can't record. Use Chrome or Edge, or upload a file.</small>}
                {refMsg && <small className="bad" role="alert">{refMsg}</small>}
              </div>
              <div className="sox-side">
                {recording
                  ? <button type="button" className="btn primary" onClick={stopRecording}>Stop and save ({seconds}s)</button>
                  : <button type="button" className={`btn${hasRef ? "" : " primary"}`} disabled={busy || !canRecord()} onClick={() => void startRecording()}>{hasRef ? "Record again" : "Record now"}</button>}
                <label className={`btn sox-file${busy || recording ? " disabled" : ""}`}>
                  Upload a file
                  <input type="file" accept="audio/wav,audio/webm,audio/mpeg,audio/mp4,audio/x-m4a,.wav,.webm,.mp3,.m4a" hidden disabled={busy || recording}
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void pickFile(f); }} />
                </label>
              </div>
            </li>
          </ul>
        </section>

        <section className="st-card">
          <header>
            <div><h2>2. Voice test</h2><p>The same line, read three ways. Pick the one that sounds most like you.</p></div>
            <button type="button" className={`btn${!t && hasRef ? " primary" : ""}`} disabled={busy || !hasRef} onClick={() => void start()}>{t ? "Run a new test" : "Run the test"}</button>
          </header>
          {test === false && <div className="st-card-body"><Callout tone="critical" icon="alert">Couldn't load the test.</Callout></div>}
          {!t && test !== false && (
            <div className="sox-row">
              <span className="sox-tile"><Icon name="sparkles" size={16} /></span>
              <div className="sox-main"><b>{test === null ? "Loading…" : "No test yet"}</b><small>{hasRef ? "Run the test and your Mac makes three clips. They show here, labelled A, B and C." : "Add a reference recording first, then run the test."}</small></div>
            </div>
          )}
          {t && (
            <>
              <div className="sox-row" style={{ paddingBottom: 0 }}><p className="sox-desc" role="status" style={{ font: "500 13px/19px var(--font)" }}>{voiceTestLine({ pending: t.pending, chosen: t.chosen })}</p></div>
              {(!t.helperOnline && t.chosen === null && t.pending > 0) || failed.length > 0 ? (
                <div className="st-card-body" style={{ paddingBottom: 0 }}>
                  {!t.helperOnline && t.chosen === null && t.pending > 0 && <Callout tone="warn" icon="alert">Your Mac helper is offline. Start it and the clips will appear here.</Callout>}
                  {failed.length > 0 && <Callout tone="critical" icon="alert">{failed[0].error ?? "A clip couldn't be made."} Run the test again.</Callout>}
                </div>
              ) : null}
              <ul className="sox-list" style={{ marginTop: 14, borderTop: "1px solid var(--border)" }}>
                {t.clips.map((c) => (
                  <li key={c.label} className={`sox-row sox-clip${t.chosen === c.label ? " chosen" : ""}`}>
                    <span className={`sox-tile ${t.chosen === c.label ? "signal" : c.status === "failed" ? "critical" : ""}`}>{c.label}</span>
                    <div className="sox-main">
                      <div className="sox-title"><b>Clip {c.label}{t.engines ? ` · ${engineName(t.engines[c.label])}` : ""}</b>{t.chosen === c.label && <Chip tone="signal" dot>Your pick</Chip>}</div>
                      {c.status === "ready" ? <audio controls preload="none" src={c.url} aria-label={`Clip ${c.label}`} /> : <small className={c.status === "failed" ? "bad" : undefined}>{c.status === "failed" ? "Couldn't be made" : "Waiting for your Mac"}</small>}
                    </div>
                    {t.chosen === null && <button type="button" className="btn sm" disabled={busy || !ready} onClick={() => void choose(c.label)}>This one</button>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="sox-card-foot">
            <span className="sox-sub" style={{ flex: 1 }}>
              {voice && voice.voice_engine ? `New videos use the cloned voice (${engineName(voice.voice_engine)}).` : voice ? "No cloned voice is set. New videos are narrated from your own recordings." : ""}
            </span>
            <button type="button" className="btn-plain" disabled={busy} onClick={() => void noneOfThese()}>None of these: I'll record my own</button>
          </div>
          {(msg || ownLines) && (
            <div className="st-card-body" style={{ borderTop: "1px solid var(--border)" }}>
              {msg && <p className="bx-err" role="alert">{msg}</p>}
              {ownLines && (
                <Callout icon="info">
                  Recording your own lines:
                  <ol>{RECORD_OWN_STEPS.map((s) => <li key={s}>{s}</li>)}</ol>
                </Callout>
              )}
            </div>
          )}
        </section>

        <Card title="In your videos" sub="Where a video sends people, and what it says about the voice.">
          <Field label="Booking link" htmlFor="vt-book" error={doc.errors.booking_url} help="Where a video sends people to book a call. An https:// link, or leave it empty.">
            <input id="vt-book" className="sox-w l" type="url" inputMode="url" maxLength={500} placeholder="https://cal.com/you" value={doc.value("booking_url")} onChange={(e) => doc.set("booking_url", e.target.value)} />
          </Field>
          <SwitchRow checked={doc.value("ai_voice_note") !== "0"} onChange={(v) => doc.set("ai_voice_note", v ? 1 : 0)} label="Say the voice is AI"
            help="A short note on the video's page that the voice is a clone of yours. Leave it on unless you narrate every video yourself." />
        </Card>
      </div>
    </SettingsPage>
  );
}
