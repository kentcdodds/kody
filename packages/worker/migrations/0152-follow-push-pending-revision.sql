-- Push-window coalesce compare-and-swap must not key on updated_at: distinct
-- pushes can share an event timestamp, so the CAS token would not move and a
-- second writer could overwrite the first. revision bumps on every write.

ALTER TABLE follow_push_pending
	ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
