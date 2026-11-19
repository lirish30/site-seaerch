-- Who watched a published video, and how far. One row per browser visit (`session` is a random id the report page makes when it loads and
-- never stores), per report link (`token`). `opened` is 0/1, `plays` counts starts, `max_pct` only rises.
CREATE TABLE video_sessions (
  token TEXT NOT NULL,
  session TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  opened INTEGER NOT NULL DEFAULT 0,
  plays INTEGER NOT NULL DEFAULT 0,
  max_pct INTEGER NOT NULL DEFAULT 0 CHECK (max_pct BETWEEN 0 AND 100),
  PRIMARY KEY (token, session)
);
-- The per-link, per-day session cap counts rows by first_at; the Watched card and the lead page read by last_at.
CREATE INDEX idx_video_sessions_first ON video_sessions(token, first_at);
CREATE INDEX idx_video_sessions_last ON video_sessions(last_at);

-- A marker per (link, milestone): the first insert wins, so a milestone is written to the lead's activity once even when two beacons land together.
-- `mark` is 'play', 'p50' or 'p90'.
CREATE TABLE video_view_marks (
  token TEXT NOT NULL,
  mark TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (token, mark)
);
