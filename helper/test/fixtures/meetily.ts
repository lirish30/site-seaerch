import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A string planted in the tables Meetily keeps keys and a licence in. The helper must never read them, so it must never show up anywhere it sends or logs. */
export const SECRET = "SECRET-KEY-DO-NOT-READ";

/** Meetily's own timestamp format, microseconds and offset included: `2026-11-17T23:11:58.787760+00:00`. */
export function meetilyTs(when: Date | string | number): string {
  return new Date(when).toISOString().replace(/Z$/, "000+00:00");
}

export interface FixtureLine { text: string; startSec?: number | null; endSec?: number | null; speaker?: string | null }
export interface FixtureMeeting {
  id: string;
  title: string;
  /** When the recording started (anything `new Date` takes). */
  createdAt: string;
  /** Defaults to `createdAt`. */
  updatedAt?: string;
  lines?: FixtureLine[];
  /** The text stored in `summary_processes.result`; leave out for a meeting that was never summarised. */
  summary?: string | null;
  /** The `summary_processes.status` (default `completed`). Giving one makes a row even when there is no `summary` text. */
  summaryStatus?: string;
  /** When the summary row was last touched; defaults to `updatedAt`. */
  summaryUpdatedAt?: string;
  /** Written to `meetings.updated_at` as-is, to model a record Meetily left unreadable. */
  rawUpdatedAt?: string;
  /** Store the result the way newer Meetily versions do, as JSON with a `markdown` field. */
  summaryAsJson?: boolean;
}

/** Creates a SQLite file with the real Meetily table shapes (plus the three tables that hold keys and a licence), fills it and returns its path. */
export function makeMeetilyDb(dir: string, opts: { meetings: FixtureMeeting[]; name?: string; /** Put the file in WAL mode, as Meetily does. */ wal?: boolean } = { meetings: [] }): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, opts.name ?? "meeting_minutes.sqlite");
  const db = new DatabaseSync(path);
  try {
    if (opts.wal) db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, folder_path TEXT);
      CREATE TABLE transcripts (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, transcript TEXT NOT NULL, timestamp TEXT NOT NULL,
        summary TEXT, action_items TEXT, key_points TEXT, audio_start_time REAL, audio_end_time REAL, duration REAL, speaker TEXT
      );
      CREATE TABLE summary_processes (
        meeting_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT, result TEXT,
        start_time TEXT, end_time TEXT, chunk_count INTEGER DEFAULT 0, processing_time REAL DEFAULT 0, metadata TEXT
      );
      CREATE TABLE settings (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, whisperModel TEXT NOT NULL, openaiApiKey TEXT, anthropicApiKey TEXT, groqApiKey TEXT);
      CREATE TABLE transcript_settings (id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, whisperApiKey TEXT, deepgramApiKey TEXT);
      CREATE TABLE licensing (id TEXT PRIMARY KEY, license_key TEXT, status TEXT, activated_at TEXT);
    `);
    db.prepare("INSERT INTO settings VALUES ('1', 'openai', 'gpt', 'base', ?, ?, ?)").run(SECRET, SECRET, SECRET);
    db.prepare("INSERT INTO transcript_settings VALUES ('1', 'deepgram', 'nova', ?, ?)").run(SECRET, SECRET);
    db.prepare("INSERT INTO licensing VALUES ('1', ?, 'active', ?)").run(SECRET, meetilyTs("2026-01-01T00:00:00Z"));

    const addMeeting = db.prepare("INSERT INTO meetings VALUES (?, ?, ?, ?, ?)");
    const addLine = db.prepare("INSERT INTO transcripts VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)");
    const addSummary = db.prepare("INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result) VALUES (?, ?, ?, ?, ?)");
    for (const m of opts.meetings) {
      const created = meetilyTs(m.createdAt);
      const updated = m.rawUpdatedAt ?? meetilyTs(m.updatedAt ?? m.createdAt);
      addMeeting.run(m.id, m.title, created, updated, `/Users/someone/Meetily/${m.id}`);
      (m.lines ?? []).forEach((l, i) => {
        const start = l.startSec ?? null;
        const end = l.endSec ?? null;
        addLine.run(`${m.id}-t${i}`, m.id, l.text, created, start, end, start !== null && end !== null ? end - start : null, l.speaker ?? null);
      });
      if (m.summary != null || m.summaryStatus) {
        const result = m.summary == null ? null : m.summaryAsJson ? JSON.stringify({ markdown: m.summary }) : m.summary;
        addSummary.run(m.id, m.summaryStatus ?? "completed", created, m.summaryUpdatedAt ? meetilyTs(m.summaryUpdatedAt) : updated, result);
      }
    }
  } finally { db.close(); }
  return path;
}
