-- Per-service monthly sub-caps inside the total monthly cap. A service with no row has no sub-cap.
-- When a service passes its cap, optional (unattended) jobs that use it pause; user-started and approved work is not gated by it.
-- Seeds: the spec's lead-data estimate is $5-20/month in total, so Bright Data and Places start at $15 each. Both are editable in Settings > Usage & limits.
CREATE TABLE spend_caps (
  service TEXT PRIMARY KEY,
  monthly_usd REAL NOT NULL CHECK (monthly_usd >= 0)
);
INSERT INTO spend_caps (service, monthly_usd) VALUES ('brightdata', 15), ('places', 15);
