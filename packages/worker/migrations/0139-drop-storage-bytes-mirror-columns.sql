-- Final storage-bytes contract boundary. UserMeter has been the storage-bytes
-- authority since the 2026-08-01 cutover; the users.d1_storage_bytes async
-- mirror was retired by the preceding code-only deploy (no runtime path reads
-- or writes byte values). The d1_storage_bytes_updated_at half served only as
-- the reconcile lane's oldest-first sweep cursor.
--
-- This migration replaces that per-user cursor with a platform-owned keyset
-- cursor row and drops the retired column pair. The same deploy ships the
-- lane re-key, and the deploy pipeline applies migrations before swapping the
-- Worker, so the outgoing Worker must not read the dropped columns — that was
-- already true after the mirror-retirement deploy.

-- `position` holds the opaque keyset boundary (the last swept
-- users.stable_user_id). It is a transient sweep position overwritten every
-- lane tick, not user-owned data, and is intentionally outside account
-- deletion/export inventory.
CREATE TABLE d1_storage_reconcile_cursor (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	position TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

INSERT INTO d1_storage_reconcile_cursor (singleton, position)
VALUES (1, '');

DROP INDEX IF EXISTS idx_users_d1_storage_bytes_reconciliation;

ALTER TABLE users DROP COLUMN d1_storage_bytes;
ALTER TABLE users DROP COLUMN d1_storage_bytes_updated_at;
