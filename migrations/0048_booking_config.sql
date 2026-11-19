-- Booking availability: weekly windows, notice, horizon, buffer and the budget options on the booking form, as one JSON document. '{}' means "use the defaults" (no windows, so no slots).
ALTER TABLE settings ADD COLUMN booking_config TEXT NOT NULL DEFAULT '{}';
