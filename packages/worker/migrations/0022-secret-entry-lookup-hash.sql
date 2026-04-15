ALTER TABLE secret_entries
ADD COLUMN lookup_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_secret_entries_lookup_hash
ON secret_entries(lookup_hash);
