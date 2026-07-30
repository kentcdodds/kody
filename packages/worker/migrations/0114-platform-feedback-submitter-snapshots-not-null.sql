-- Make platform-feedback submitter username/email snapshots mandatory.
-- Migration 0063 added nullable columns, leaving older rows without snapshots.
--
-- Backfill each missing snapshot from the current users row matched by stable
-- user id. Delete feedback that still lacks either snapshot: this pre-launch
-- data cannot satisfy the attribution contract and is intentionally discarded.
--
-- SQLite cannot add NOT NULL in place, so rebuild the table and recreate every
-- index. Assertions fail closed if the cleanup leaves an invalid row.

UPDATE platform_feedback
SET
	submitter_username = COALESCE(
		submitter_username,
		(
			SELECT users.username
			FROM users
			WHERE users.stable_user_id = platform_feedback.submitter_user_id
		)
	),
	submitter_email = COALESCE(
		submitter_email,
		(
			SELECT users.email
			FROM users
			WHERE users.stable_user_id = platform_feedback.submitter_user_id
		)
	)
WHERE submitter_username IS NULL OR submitter_email IS NULL;

DELETE FROM platform_feedback
WHERE submitter_username IS NULL OR submitter_email IS NULL;

DROP TABLE IF EXISTS __migration_assertions;

-- __migration_assertions intentionally uses CHECK (0) as an unreachable trap.
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'platform_feedback contains a null submitter snapshot; aborting 0114.'
WHERE EXISTS (
	SELECT 1
	FROM platform_feedback
	WHERE submitter_username IS NULL OR submitter_email IS NULL
);

DROP TABLE __migration_assertions;

CREATE TABLE platform_feedback_next (
	id TEXT PRIMARY KEY NOT NULL,
	submitter_user_id TEXT NOT NULL,
	category TEXT NOT NULL CHECK (
		category IN ('friction', 'bug', 'experience', 'suggestion', 'other')
	),
	summary TEXT NOT NULL CHECK (
		length(summary) BETWEEN 1 AND 200
	),
	details TEXT NOT NULL CHECK (
		length(details) BETWEEN 1 AND 8000
	),
	status TEXT NOT NULL DEFAULT 'open' CHECK (
		status IN ('open', 'triaged', 'resolved', 'dismissed')
	),
	reviewed_by_user_id TEXT,
	reviewed_at TEXT,
	admin_note TEXT CHECK (
		admin_note IS NULL OR length(admin_note) <= 2000
	),
	revision INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	submitter_username TEXT NOT NULL,
	submitter_email TEXT NOT NULL
);

INSERT INTO platform_feedback_next (
	id,
	submitter_user_id,
	category,
	summary,
	details,
	status,
	reviewed_by_user_id,
	reviewed_at,
	admin_note,
	revision,
	created_at,
	updated_at,
	submitter_username,
	submitter_email
)
SELECT
	id,
	submitter_user_id,
	category,
	summary,
	details,
	status,
	reviewed_by_user_id,
	reviewed_at,
	admin_note,
	revision,
	created_at,
	updated_at,
	submitter_username,
	submitter_email
FROM platform_feedback;

DROP TABLE platform_feedback;

ALTER TABLE platform_feedback_next RENAME TO platform_feedback;

-- Admin list ordering without filters.
CREATE INDEX idx_platform_feedback_created_at_id
ON platform_feedback(created_at DESC, id DESC);

-- Admin status and category filters preserve the requested list ordering.
CREATE INDEX idx_platform_feedback_status_created_at_id
ON platform_feedback(status, created_at DESC, id DESC);

CREATE INDEX idx_platform_feedback_category_created_at_id
ON platform_feedback(category, created_at DESC, id DESC);

-- Reviewer account cleanup.
CREATE INDEX idx_platform_feedback_reviewer
ON platform_feedback(reviewed_by_user_id);

-- Atomic active-queue counts plus submitter deletion/export paths.
CREATE INDEX idx_platform_feedback_submitter_status
ON platform_feedback(submitter_user_id, status);

-- Rolling per-submitter submission counts.
CREATE INDEX idx_platform_feedback_submitter_created_at
ON platform_feedback(submitter_user_id, created_at);

-- Terminal feedback retention scans only resolved/dismissed rows by age.
CREATE INDEX idx_platform_feedback_terminal_updated_at_id
ON platform_feedback(updated_at, id)
WHERE status IN ('resolved', 'dismissed');
