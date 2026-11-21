-- A meeting recorded by Meetily (Plan 10). Times are UTC ISO strings with milliseconds, so comparing them as text compares them in time.
-- meetily_id is Meetily's own id for the recording; the UNIQUE makes a re-sent meeting a no-op. window_key names the pull window it arrived in.
-- transcript_key is the R2 key of the transcript, never the text. summary is JSON (MeetingSummary) once the AI summary is saved.
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  meetily_id TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  window_key TEXT NOT NULL,
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  transcript_key TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN ('received', 'summarized', 'failed')),
  summary TEXT,
  followup_sent_at TEXT,
  created_at TEXT NOT NULL,
  summarized_at TEXT
);
CREATE INDEX idx_meetings_business ON meetings(business_id, started_at);
