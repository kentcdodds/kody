-- Browser session invalidation after password reset. Sessions carry an
-- issuedAt timestamp; resolveRequestAuth rejects cookies issued at or before
-- password_changed_at so a reset logs out every existing browser session.
ALTER TABLE users ADD COLUMN password_changed_at TEXT;
