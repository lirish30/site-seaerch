-- A booked call with a lead (spec section 9.4). Times are UTC ISO strings with milliseconds ("2026-12-01T18:00:00.000Z"), so comparing them as text compares them in time.
-- answers is JSON (topic, budgetId, timeline, decisionMaker) as the person typed it; it is escaped wherever it is shown, never trusted.
-- cancel_token is the secret in the guest's cancel link (32 random bytes, base64url).
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('discovery', 'recommendation')),
  status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled', 'held', 'no_show')),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  answers TEXT,
  calendar_event_id TEXT,
  meet_url TEXT,
  cancel_token TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('visitor', 'logan')),
  created_at TEXT NOT NULL,
  cancelled_at TEXT
);
CREATE INDEX idx_bookings_start ON bookings(start_at);
-- A lead holds one confirmed discovery call at a time.
CREATE UNIQUE INDEX uq_bookings_discovery ON bookings(business_id) WHERE kind = 'discovery' AND status = 'confirmed';
CREATE UNIQUE INDEX uq_bookings_cancel_token ON bookings(cancel_token);
