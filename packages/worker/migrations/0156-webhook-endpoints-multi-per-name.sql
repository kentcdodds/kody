-- Multiple minted URLs may share one declared webhook name. The URL (endpoint
-- id) is the identity; webhook_name stays display metadata. Existing rows keep
-- working — only the unique (user, package, name) index is relaxed.
-- instance_label is a short user-set label to tell endpoints under the same
-- name apart (nullable for pre-existing mints).

DROP INDEX IF EXISTS idx_webhook_endpoints_user_package_name;

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user_package_name
ON webhook_endpoints(user_id, package_id, webhook_name);

ALTER TABLE webhook_endpoints ADD COLUMN instance_label TEXT;
