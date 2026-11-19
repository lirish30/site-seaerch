-- Video settings: the cloned voice, the booking link a video points to, and the note that says the voice is AI.
-- `voice_engine` is the engine the owner picked in the blind A/B test (NULL until they pick, or after "none of these": then they record their own lines).
-- `voice_ref_key` is the R2 key of their reference recording. `ai_voice_note` is 1/0: the video page says the voice is cloned.
ALTER TABLE settings ADD COLUMN voice_engine TEXT CHECK (voice_engine IN ('qwen3-tts','chatterbox','openvoice-v2'));
ALTER TABLE settings ADD COLUMN voice_ref_key TEXT;
ALTER TABLE settings ADD COLUMN booking_url TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN ai_voice_note INTEGER NOT NULL DEFAULT 1;

-- One blind voice test: the same line read by the three engines. `labels` is JSON { "A": engine, "B": engine, "C": engine }, shuffled, and kept
-- from the page until `chosen` (the label picked) is set.
CREATE TABLE voice_tests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  line_text TEXT NOT NULL,
  labels TEXT NOT NULL,
  chosen TEXT CHECK (chosen IN ('A','B','C'))
);
CREATE INDEX idx_voice_tests_created ON voice_tests(created_at);
