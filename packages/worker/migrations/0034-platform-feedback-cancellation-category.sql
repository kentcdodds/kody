-- Add 'cancellation' to the platform_feedback.category CHECK constraint.
-- SQLite cannot alter a CHECK constraint, so rebuild the table.
DROP TABLE IF EXISTS platform_feedback__with_cancellation;

CREATE TABLE platform_feedback__with_cancellation (
	id TEXT PRIMARY KEY NOT NULL,
	submitter_user_id TEXT NOT NULL,
	category TEXT NOT NULL CHECK (
		category IN (
			'friction',
			'bug',
			'experience',
			'suggestion',
			'cancellation',
			'other'
		)
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

INSERT INTO platform_feedback__with_cancellation (
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

ALTER TABLE platform_feedback__with_cancellation RENAME TO platform_feedback;

CREATE INDEX IF NOT EXISTS idx_platform_feedback_created_at_id
ON platform_feedback(created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_platform_feedback_status_created_at_id
ON platform_feedback(status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_platform_feedback_category_created_at_id
ON platform_feedback(category, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_platform_feedback_reviewer
ON platform_feedback(reviewed_by_user_id);

CREATE INDEX IF NOT EXISTS idx_platform_feedback_submitter_status
ON platform_feedback(submitter_user_id, status);

CREATE INDEX IF NOT EXISTS idx_platform_feedback_submitter_created_at
ON platform_feedback(submitter_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_platform_feedback_terminal_updated_at_id
ON platform_feedback(updated_at, id)
WHERE status IN ('resolved', 'dismissed');
