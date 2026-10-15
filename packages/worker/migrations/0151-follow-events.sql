-- Follow any repo: the follower chooses which events a follow delivers, and a
-- paused follow records why it paused. Existing follows keep every event.

ALTER TABLE follows ADD COLUMN published_enabled INTEGER NOT NULL DEFAULT 1;

ALTER TABLE follows ADD COLUMN pushed_enabled INTEGER NOT NULL DEFAULT 1;

-- 'target_missing' | 'access_lost'. NULL for active follows and for rows that
-- paused before this column existed.
ALTER TABLE follows ADD COLUMN paused_reason TEXT;
