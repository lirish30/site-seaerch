-- The scopes Google actually granted, from the token response. Rows connected before the calendar scopes stay NULL, which reads as "reconnect to enable booking".
ALTER TABLE google_auth ADD COLUMN scope TEXT;
