-- Star a lead to find it again. The timestamp is when it was starred (NULL = not starred), so the Today queue can say how long ago.
ALTER TABLE businesses ADD COLUMN starred_at TEXT;
-- Only starred rows are indexed: the list sorts them first and the Starred filter reads just them.
CREATE INDEX idx_businesses_starred ON businesses(starred_at) WHERE starred_at IS NOT NULL;
