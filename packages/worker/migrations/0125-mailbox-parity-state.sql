-- Account-owned Mailbox parity / backfill state for the five-minute reconcile lane.
-- Low-write columns live on users (not per-message). Creation cursors are
-- keyset (created_at, id) for messages and ALL owner delivery events so backfill
-- can resume across ticks without DO enumeration. The event phase rescans every
-- email_delivery_events row (not only message_id-null) so per-message graph
-- truncation cannot leave DO events behind. content_watermark_at is set to the
-- run's now at the start of the first backfill attempt (retained across
-- incomplete/error ticks). After both creation phases complete, a durable
-- content-replay window (replay_upper_at + replay cursor) keyset-replays
-- messages with updated_at in (watermark, upper]; the watermark advances to
-- upper only when that window finishes. Count compare runs only after the full
-- event phase and a completed content window. Count mismatch best-effort purges
-- Mailbox SQLite metadata (no R2), then clears soak and resets creation cursors,
-- completion markers, and content watermark/window for an authoritative D1
-- rebuild. Purge timeout/error clears soak, records failure, and does not reset
-- rebuild state. Previously tracked users stay eligible even at zero D1 rows.
-- matching_since may persist across a successful content replay + exact compare.

ALTER TABLE users ADD COLUMN mailbox_parity_checked_at TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_matching_since TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_mismatch_count INTEGER NOT NULL DEFAULT 0
	CHECK (mailbox_parity_mismatch_count >= 0);
ALTER TABLE users ADD COLUMN mailbox_parity_last_error TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_content_watermark_at TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_content_replay_upper_at TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_content_replay_cursor_updated_at TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_content_replay_cursor_id TEXT;

ALTER TABLE users ADD COLUMN mailbox_parity_message_backfill_cursor_created_at TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_message_backfill_cursor_id TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_message_backfill_completed_at TEXT;

ALTER TABLE users ADD COLUMN mailbox_parity_event_backfill_cursor_created_at TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_event_backfill_cursor_id TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_event_backfill_completed_at TEXT;

CREATE INDEX idx_users_mailbox_parity_checked
	ON users(mailbox_parity_checked_at, stable_user_id);

-- Keyset-friendly composites for creation scans and content replay.
CREATE INDEX IF NOT EXISTS idx_email_messages_user_created_at_id
	ON email_messages(user_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_email_messages_user_updated_at_id
	ON email_messages(user_id, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_email_delivery_events_user_created_at_id
	ON email_delivery_events(user_id, created_at, id);
