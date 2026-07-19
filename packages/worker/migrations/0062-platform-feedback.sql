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
	revision INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

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
