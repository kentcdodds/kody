-- Account-owned Mailbox parity / backfill state for the hourly reconcile lane.
-- Low-write columns live on users (not per-message). Creation cursors are
-- keyset (created_at, id) so message and message_id-null orphan-event backfill
-- can resume across ticks without DO enumeration. content_watermark_at is set
-- to the run's now at the start of the first backfill attempt (retained across
-- incomplete/error ticks) and bounds a keyset replay of messages with
-- updated_at in (watermark, current-now] after both initial backfills complete
-- so classification-like updates — including those that land after a graph was
-- mirrored but before backfill finished — are remirrored even when counts stay
-- equal; the watermark advances only after the full window succeeds.
-- matching_since records the start of continuous exact D1 ↔Mailbox count
-- parity for soak tracking; it clears on initial backfill work,
-- incomplete/budget-exhausted ticks, mirror errors, content-replay
-- failure/incomplete, or compare mismatch — but may persist across a
-- successful content replay + exact compare. mismatch_count is consecutive
-- current mismatch depth and resets to 0 on exact match.

ALTER TABLE users ADD COLUMN mailbox_parity_checked_at TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_matching_since TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_mismatch_count INTEGER NOT NULL DEFAULT 0
	CHECK (mailbox_parity_mismatch_count >= 0);
ALTER TABLE users ADD COLUMN mailbox_parity_last_error TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_content_watermark_at TEXT;

ALTER TABLE users ADD COLUMN mailbox_parity_message_backfill_cursor_created_at TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_message_backfill_cursor_id TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_message_backfill_completed_at TEXT;

ALTER TABLE users ADD COLUMN mailbox_parity_orphan_event_backfill_cursor_created_at TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_orphan_event_backfill_cursor_id TEXT;
ALTER TABLE users ADD COLUMN mailbox_parity_orphan_event_backfill_completed_at TEXT;

CREATE INDEX idx_users_mailbox_parity_checked
	ON users(mailbox_parity_checked_at, stable_user_id);
