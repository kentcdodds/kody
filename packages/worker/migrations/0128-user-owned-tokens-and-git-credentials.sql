-- Additive user-owned API tokens (org picked per request) and short-lived
-- git access tokens for `kody auth setup-git` credential helpers.
-- Existing org-bound api_tokens keep org_binding = 'org' (DEFAULT) unchanged.

ALTER TABLE api_tokens ADD COLUMN org_binding TEXT NOT NULL DEFAULT 'org';

-- Outstanding bootstrap codes stay org-bound so in-flight redeems do not change.
-- New CLI bootstrap inserts set org_binding = 'user' explicitly.
ALTER TABLE cli_credential_bootstrap_codes
	ADD COLUMN org_binding TEXT NOT NULL DEFAULT 'org';

CREATE TABLE git_access_tokens (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	token_hash TEXT NOT NULL,
	owner_handle TEXT NOT NULL,
	repo_name TEXT NOT NULL,
	resource_kind TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	resource_org_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	last_used_at TEXT,
	revoked_at TEXT,
	deleted_at TEXT,
	deleting_at TEXT
);

CREATE INDEX git_access_tokens_user_created_idx
	ON git_access_tokens (user_id, created_at);

CREATE INDEX git_access_tokens_resource_idx
	ON git_access_tokens (resource_org_id, resource_kind, resource_id);
