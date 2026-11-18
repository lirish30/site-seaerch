-- The AI site review now runs later, through the Claude queue, so the audit is first scored on rules alone and re-scored when the review comes back.
-- `score_inputs_key` is the R2 key of a JSON file holding everything `score()` was given except the review (site status, crawl facts, PageSpeed,
-- mobile measurements, business signals, mail DNS and the time), so the re-score is the same calculation plus the review. NULL for older audits.
ALTER TABLE audits ADD COLUMN score_inputs_key TEXT;
