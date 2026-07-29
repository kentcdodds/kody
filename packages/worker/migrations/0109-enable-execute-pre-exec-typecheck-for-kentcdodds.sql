-- Start the pre-exec TypeScript checker rollout with a single durable
-- per-user override. The SELECT is harmless in environments where this user
-- does not exist, and the upsert makes local/replayed application idempotent.
INSERT INTO feature_flag_user_overrides (
	flag_key,
	user_id,
	enabled,
	updated_by,
	updated_at
)
SELECT
	'execute-pre-exec-typecheck',
	id,
	1,
	NULL,
	CURRENT_TIMESTAMP
FROM users
WHERE username = 'kentcdodds'
ON CONFLICT(flag_key, user_id) DO UPDATE SET
	enabled = excluded.enabled,
	updated_by = NULL,
	updated_at = CURRENT_TIMESTAMP;
