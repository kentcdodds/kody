ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'person' CHECK (account_type IN ('person', 'platform'));

-- User id columns hold stable MCP user ids (users.stable_user_id), matching
-- saved_packages/community_* ownership columns and the account deletion and
-- export machinery.
CREATE TABLE package_scope_grants (
	scope_owner_user_id TEXT NOT NULL,
	grantee_user_id TEXT NOT NULL,
	created_by_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	PRIMARY KEY (scope_owner_user_id, grantee_user_id),
	CHECK (scope_owner_user_id != grantee_user_id)
);

CREATE INDEX idx_package_scope_grants_grantee_user_id
ON package_scope_grants(grantee_user_id);
