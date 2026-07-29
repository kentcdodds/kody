ALTER TABLE jobs ADD COLUMN claim_token TEXT;
ALTER TABLE jobs ADD COLUMN running_since TEXT;
ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE jobs ADD COLUMN claimed_scheduled_for TEXT;
ALTER TABLE jobs ADD COLUMN retry_scheduled_for TEXT;
ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN last_completed_scheduled_for TEXT;
