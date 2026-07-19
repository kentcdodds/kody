CREATE TABLE platform_feedback (
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
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_platform_feedback_status_created_at
ON platform_feedback(status, created_at DESC);

CREATE INDEX idx_platform_feedback_submitter_created_at
ON platform_feedback(submitter_user_id, created_at DESC);
