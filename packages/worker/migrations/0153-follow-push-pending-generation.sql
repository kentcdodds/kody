-- revision restarts at 0 when a flushed window is deleted and a new push
-- inserts the same target, so a stale flush or writer holding the old
-- revision could match the new row. generation is a per-insert identity
-- paired with revision for compare-and-swap. Existing rows get ''.

ALTER TABLE follow_push_pending
	ADD COLUMN generation TEXT NOT NULL DEFAULT '';
