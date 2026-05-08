CREATE INDEX IF NOT EXISTS workflow_runs_user_idempotency_idx
ON workflow_runs(user_id, idempotency_key, created_at);
