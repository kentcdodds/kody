-- Repair incomplete Teams P4 (0090) `local-execute` → `org:execute` rewrite
-- and expand CLI bootstrap *tokens* so CapabilityProxy can run saved packages
-- that use integrations, secrets, email, and jobs.
--
-- Pre-P4 `local-execute` only gated CapabilityProxy / package-graph routes;
-- per-capability token scopes were not checked on proxy hops. After P4,
-- `authorize` narrows every hop by credential scopes, so `org:execute` alone
-- is not enough. Map and repair to the use-level parity set in
-- `packages/worker/src/api-tokens/legacy-scope-rewrite.ts`
-- (`localExecuteOrgPermissions`).
--
-- Repair targets (narrow — do not widen intentional CI tokens that already
-- hold `package:execute` via `tokenCreate`):
-- - `api_tokens.created_via = 'cli-bootstrap'` missing any parity scope
-- - `api_tokens` with `org:execute` but without `package:execute` (0090
--   local-execute rewrite left only org:execute)
--
-- Outstanding `cli_credential_bootstrap_codes` are NOT widened here: they are
-- short-lived (≤15m), and expanding a pending code after its parent token was
-- revoked would mint scopes the parent never authorized. Post-deploy mints
-- already get parity defaults from `cliCredentialBootstrapPolicy`.
-- Idempotent: already-complete rows are left unchanged.

DROP TABLE IF EXISTS __local_execute_parity;
CREATE TABLE __local_execute_parity (perm TEXT NOT NULL PRIMARY KEY);

INSERT INTO __local_execute_parity (perm) VALUES
	('app:execute'),
	('app:read'),
	('email:read'),
	('email:send'),
	('integration:read'),
	('integration:use'),
	('job:execute'),
	('job:read'),
	('memory:read'),
	('org:execute'),
	('package:execute'),
	('package:read'),
	('secret:use');

UPDATE api_tokens
SET scopes_json = (
	SELECT json_group_array(perm)
	FROM (
		SELECT perm
		FROM (
			SELECT j.value AS perm
			FROM json_each(api_tokens.scopes_json) AS j
			UNION
			SELECT p.perm AS perm
			FROM __local_execute_parity AS p
		)
		ORDER BY perm
	)
)
WHERE EXISTS (
	SELECT 1 FROM json_each(api_tokens.scopes_json) WHERE value = 'org:execute'
)
AND EXISTS (
	SELECT 1
	FROM __local_execute_parity AS p
	WHERE NOT EXISTS (
		SELECT 1
		FROM json_each(api_tokens.scopes_json) AS j
		WHERE j.value = p.perm
	)
)
AND (
	created_via = 'cli-bootstrap'
	OR NOT EXISTS (
		SELECT 1
		FROM json_each(api_tokens.scopes_json)
		WHERE value = 'package:execute'
	)
);

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

-- Repaired targets must hold the full parity set.
INSERT INTO __migration_assertions (message)
SELECT 'api_tokens cli-bootstrap / incomplete-local-execute rows still missing parity after 0092; aborting.'
WHERE EXISTS (
	SELECT 1
	FROM api_tokens AS t
	JOIN __local_execute_parity AS p
	WHERE EXISTS (
		SELECT 1 FROM json_each(t.scopes_json) WHERE value = 'org:execute'
	)
	AND (
		t.created_via = 'cli-bootstrap'
		OR NOT EXISTS (
			SELECT 1 FROM json_each(t.scopes_json) WHERE value = 'package:execute'
		)
	)
	AND NOT EXISTS (
		SELECT 1 FROM json_each(t.scopes_json) AS j WHERE j.value = p.perm
	)
);

DROP TABLE __migration_assertions;
DROP TABLE __local_execute_parity;
