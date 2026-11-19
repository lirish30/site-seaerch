-- One row per reminder that went out (or was deliberately skipped): the claim a 5-minute tick takes before it sends. The primary key makes the claim once-only, so two ticks
-- that overlap cannot both send. A failed send deletes its row, so the next tick can try again while the reminder's window lasts. offset_min is minutes before the start.
CREATE TABLE booking_reminders (
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  offset_min INTEGER NOT NULL CHECK (offset_min IN (1440, 60, 10)),
  sent_at TEXT NOT NULL,
  PRIMARY KEY (booking_id, offset_min)
);
