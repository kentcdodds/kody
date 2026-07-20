-- Editable nickname plus last-used timestamp so users can tell passkeys apart.
ALTER TABLE passkeys ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE passkeys ADD COLUMN last_used_at TEXT;
