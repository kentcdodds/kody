-- Per-secret expiry for user and package secrets. Session lifetime stays on
-- secret_buckets.expires_at; this column is the user-settable date the list
-- and secret_set surfaces already implied.
ALTER TABLE secret_entries
ADD COLUMN expires_at TEXT;
