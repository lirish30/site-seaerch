-- Video audits: one narrated walkthrough video per site audit. `plan` is the VideoPlan JSON (shots, segments, narration, version),
-- NULL until the script exists. The keys point at R2 objects. `publish_approval_id` links the approval that publishes it.
CREATE TABLE video_audits (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'capturing' CHECK (status IN ('capturing','scripting','review','producing','rendered','published','failed','cancelled')),
  plan TEXT,
  steering_note TEXT,
  video_key TEXT,
  gif_key TEXT,
  poster_key TEXT,
  duration_ms INTEGER,
  publish_approval_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX idx_video_audits_business ON video_audits(business_id, created_at);
-- One open video per audit: a failed or cancelled one frees the audit for another.
CREATE UNIQUE INDEX uq_video_audits_open ON video_audits(audit_id) WHERE status NOT IN ('failed','cancelled');
