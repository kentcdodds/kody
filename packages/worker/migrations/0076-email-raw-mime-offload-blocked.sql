-- Transitional claim flag for raw MIME offload vs delete races. Deletion paths
-- set blocked=1 for the exact user-scoped rows before R2/D1 cleanup so the
-- offload sweep cannot clear or rewrite those rows mid-delete. Dropped later
-- with the legacy raw_mime column.
ALTER TABLE email_messages
ADD COLUMN raw_mime_offload_blocked INTEGER NOT NULL DEFAULT 0
CHECK (raw_mime_offload_blocked IN (0, 1));

-- Residual unblocked inline rows for the offload maintenance sweep.
CREATE INDEX idx_email_messages_raw_mime_offload_unblocked
ON email_messages (id)
WHERE raw_mime IS NOT NULL
	AND raw_mime_offload_blocked = 0;

-- Sticky operational tombstones for just-put EMAIL_BLOBS orphans when CAS-miss
-- cleanup fails. Keyed by R2 object key; every mutation binds object_key +
-- user_id. Deleted with the account (after best-effort R2 cleanup) and omitted
-- from account export (includeInExport: false on the user_id target).
CREATE TABLE email_raw_mime_cleanup_queue (
	object_key TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_email_raw_mime_cleanup_queue_user_id
ON email_raw_mime_cleanup_queue (user_id);
