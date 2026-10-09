-- Teams P3 expand: org-scoped audit trail (AUDIT_DB). Platform audit_events
-- stays site-admin-only and unchanged. See docs/contributing/decisions/0063.

CREATE TABLE org_audit_events (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	actor_user_id TEXT,
	actor_username TEXT,
	credential_kind TEXT,
	credential_id TEXT,
	action TEXT NOT NULL,
	resource_type TEXT,
	resource_id TEXT,
	target_user_id TEXT,
	result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'denied')),
	details_json TEXT,
	ip_hash TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX idx_org_audit_org_time
	ON org_audit_events (org_id, created_at DESC);
