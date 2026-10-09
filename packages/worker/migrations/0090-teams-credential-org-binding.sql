-- Teams P4: bind credentials to an org (default personal org = user_id) and
-- rewrite API token / bootstrap scopes to the org-permission vocabulary.
-- Scope rewrite is SQL-only so remote D1 apply stays one migration. The same
-- map lives in packages/worker/src/api-tokens/legacy-scope-rewrite.ts; the
-- companion tools/teams-migration/rewrite-api-token-scopes.ts can re-run it
-- for local repair. Connection profiles stay an org-bound narrowing layer.

ALTER TABLE api_tokens ADD COLUMN org_id TEXT;
ALTER TABLE cli_credential_bootstrap_codes ADD COLUMN org_id TEXT;
ALTER TABLE mcp_agent_sessions ADD COLUMN org_id TEXT;
ALTER TABLE connection_profiles ADD COLUMN org_id TEXT;

UPDATE api_tokens SET org_id = user_id WHERE org_id IS NULL;
UPDATE cli_credential_bootstrap_codes SET org_id = user_id WHERE org_id IS NULL;
UPDATE mcp_agent_sessions SET org_id = user_id WHERE org_id IS NULL;
UPDATE connection_profiles SET org_id = user_id WHERE org_id IS NULL;

CREATE INDEX api_tokens_org_user_idx ON api_tokens (org_id, user_id);
CREATE INDEX cli_credential_bootstrap_codes_org_user_idx
	ON cli_credential_bootstrap_codes (org_id, user_id);
CREATE INDEX mcp_agent_sessions_org_user_idx
	ON mcp_agent_sessions (org_id, user_id);
CREATE INDEX connection_profiles_org_name_idx
	ON connection_profiles (org_id, name);

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'api_tokens.org_id is null after 0090 backfill; aborting.'
WHERE EXISTS (SELECT 1 FROM api_tokens WHERE org_id IS NULL OR TRIM(org_id) = '');

INSERT INTO __migration_assertions (message)
SELECT 'cli_credential_bootstrap_codes.org_id is null after 0090 backfill; aborting.'
WHERE EXISTS (
	SELECT 1 FROM cli_credential_bootstrap_codes
	WHERE org_id IS NULL OR TRIM(org_id) = ''
);

INSERT INTO __migration_assertions (message)
SELECT 'mcp_agent_sessions.org_id is null after 0090 backfill; aborting.'
WHERE EXISTS (
	SELECT 1 FROM mcp_agent_sessions WHERE org_id IS NULL OR TRIM(org_id) = ''
);

INSERT INTO __migration_assertions (message)
SELECT 'connection_profiles.org_id is null after 0090 backfill; aborting.'
WHERE EXISTS (
	SELECT 1 FROM connection_profiles WHERE org_id IS NULL OR TRIM(org_id) = ''
);

DROP TABLE __migration_assertions;

-- §5.3 rewrite: one row per (legacy scope, expanded org permission).
-- Already-valid org permissions are not in this table and pass through.
-- D1 rejects TEMP tables (SQLITE_AUTH); use a normal helper table like
-- __migration_assertions and drop it after the rewrite assertions.
DROP TABLE IF EXISTS __legacy_scope_expand;
CREATE TABLE __legacy_scope_expand (
	old TEXT NOT NULL,
	new TEXT NOT NULL
);

INSERT INTO __legacy_scope_expand (old, new) VALUES
	('account:read', 'billing:read'),
	('account:read', 'member:read'),
	('account:read', 'org:read'),
	('account:write', 'billing:read'),
	('account:write', 'billing:write'),
	('account:write', 'member:read'),
	('account:write', 'org:read'),
	('account:write', 'org:write'),
	('memories:read', 'memory:read'),
	('memories:write', 'memory:create'),
	('memories:write', 'memory:delete'),
	('memories:write', 'memory:read'),
	('memories:write', 'memory:write'),
	('secrets:read', 'secret:use'),
	('secrets:write', 'secret:create'),
	('secrets:write', 'secret:delete'),
	('secrets:write', 'secret:use'),
	('secrets:write', 'secret:write'),
	('packages:read', 'app:execute'),
	('packages:read', 'app:read'),
	('packages:read', 'package:execute'),
	('packages:read', 'package:read'),
	('packages:write', 'app:delete'),
	('packages:write', 'app:execute'),
	('packages:write', 'app:read'),
	('packages:write', 'app:write'),
	('packages:write', 'package:create'),
	('packages:write', 'package:delete'),
	('packages:write', 'package:execute'),
	('packages:write', 'package:manage_access'),
	('packages:write', 'package:read'),
	('packages:write', 'package:write'),
	('repos:read', 'package:read'),
	('repos:write', 'package:read'),
	('repos:write', 'package:write'),
	('jobs:read', 'job:read'),
	('jobs:write', 'job:create'),
	('jobs:write', 'job:delete'),
	('jobs:write', 'job:execute'),
	('jobs:write', 'job:read'),
	('jobs:write', 'job:write'),
	('webhooks:read', 'package:read'),
	('webhooks:write', 'package:read'),
	('webhooks:write', 'package:write'),
	('email:read', 'email:read'),
	('email:write', 'email:create'),
	('email:write', 'email:delete'),
	('email:write', 'email:read'),
	('email:write', 'email:send'),
	('email:write', 'email:write'),
	('integrations:read', 'integration:read'),
	('integrations:write', 'integration:create'),
	('integrations:write', 'integration:delete'),
	('integrations:write', 'integration:read'),
	('integrations:write', 'integration:use'),
	('integrations:write', 'integration:write'),
	('mcp-servers:read', 'integration:read'),
	('mcp-servers:write', 'integration:create'),
	('mcp-servers:write', 'integration:delete'),
	('mcp-servers:write', 'integration:read'),
	('mcp-servers:write', 'integration:use'),
	('mcp-servers:write', 'integration:write'),
	('runs:read', 'job:read'),
	('runs:read', 'package:read'),
	('runs:write', 'job:execute'),
	('runs:write', 'job:read'),
	('runs:write', 'package:read'),
	('storage:read', 'package:read'),
	('storage:write', 'package:read'),
	('storage:write', 'package:write'),
	('community:read', 'org:read'),
	('community:write', 'org:read'),
	('community:write', 'package:publish'),
	('tokens:read', 'token:read'),
	('tokens:write', 'token:delete'),
	('tokens:write', 'token:read'),
	('search:read', 'search:read'),
	('local-execute', 'org:execute');

UPDATE api_tokens
SET scopes_json = (
	SELECT COALESCE(
		(
			SELECT json_group_array(perm)
			FROM (
				SELECT perm FROM (
					SELECT e.new AS perm
					FROM json_each(api_tokens.scopes_json) AS j
					JOIN __legacy_scope_expand e ON e.old = j.value
					UNION
					SELECT j.value AS perm
					FROM json_each(api_tokens.scopes_json) AS j
					WHERE NOT EXISTS (
						SELECT 1 FROM __legacy_scope_expand e WHERE e.old = j.value
					)
				)
				ORDER BY perm
			)
		),
		'[]'
	)
);

UPDATE cli_credential_bootstrap_codes
SET scopes_json = (
	SELECT COALESCE(
		(
			SELECT json_group_array(perm)
			FROM (
				SELECT perm FROM (
					SELECT e.new AS perm
					FROM json_each(cli_credential_bootstrap_codes.scopes_json) AS j
					JOIN __legacy_scope_expand e ON e.old = j.value
					UNION
					SELECT j.value AS perm
					FROM json_each(cli_credential_bootstrap_codes.scopes_json) AS j
					WHERE NOT EXISTS (
						SELECT 1 FROM __legacy_scope_expand e WHERE e.old = j.value
					)
				)
				ORDER BY perm
			)
		),
		'[]'
	)
);

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'api_tokens.scopes_json has a non-org-permission scope after 0090 rewrite; aborting.'
WHERE EXISTS (
	SELECT 1
	FROM api_tokens t
	JOIN json_each(t.scopes_json) j
	WHERE j.value NOT IN (
		'package:read',
		'package:execute',
		'package:write',
		'package:delete',
		'package:publish',
		'package:manage_access',
		'package:create',
		'app:read',
		'app:execute',
		'app:write',
		'app:delete',
		'app:manage_access',
		'app:create',
		'job:read',
		'job:execute',
		'job:write',
		'job:delete',
		'job:manage_access',
		'job:create',
		'secret:use',
		'secret:read',
		'secret:write',
		'secret:delete',
		'secret:manage_access',
		'secret:create',
		'integration:use',
		'integration:read',
		'integration:write',
		'integration:delete',
		'integration:manage_access',
		'integration:create',
		'memory:read',
		'memory:write',
		'memory:delete',
		'memory:manage_access',
		'memory:create',
		'email:read',
		'email:send',
		'email:write',
		'email:delete',
		'email:manage_access',
		'email:create',
		'org:read',
		'org:write',
		'org:delete',
		'org:execute',
		'search:read',
		'member:read',
		'member:write',
		'member:delete',
		'team:read',
		'team:write',
		'team:delete',
		'billing:read',
		'billing:write',
		'audit:read',
		'token:read',
		'token:delete'
	)
);

INSERT INTO __migration_assertions (message)
SELECT 'cli_credential_bootstrap_codes.scopes_json has a non-org-permission scope after 0090 rewrite; aborting.'
WHERE EXISTS (
	SELECT 1
	FROM cli_credential_bootstrap_codes t
	JOIN json_each(t.scopes_json) j
	WHERE j.value NOT IN (
		'package:read',
		'package:execute',
		'package:write',
		'package:delete',
		'package:publish',
		'package:manage_access',
		'package:create',
		'app:read',
		'app:execute',
		'app:write',
		'app:delete',
		'app:manage_access',
		'app:create',
		'job:read',
		'job:execute',
		'job:write',
		'job:delete',
		'job:manage_access',
		'job:create',
		'secret:use',
		'secret:read',
		'secret:write',
		'secret:delete',
		'secret:manage_access',
		'secret:create',
		'integration:use',
		'integration:read',
		'integration:write',
		'integration:delete',
		'integration:manage_access',
		'integration:create',
		'memory:read',
		'memory:write',
		'memory:delete',
		'memory:manage_access',
		'memory:create',
		'email:read',
		'email:send',
		'email:write',
		'email:delete',
		'email:manage_access',
		'email:create',
		'org:read',
		'org:write',
		'org:delete',
		'org:execute',
		'search:read',
		'member:read',
		'member:write',
		'member:delete',
		'team:read',
		'team:write',
		'team:delete',
		'billing:read',
		'billing:write',
		'audit:read',
		'token:read',
		'token:delete'
	)
);

DROP TABLE __migration_assertions;
DROP TABLE __legacy_scope_expand;
