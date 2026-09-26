-- Owner approvals for generic webhookUrlApply http destinations.
-- Same deny → approval_url → website grant → retry loop as secret host
-- approval (/connect/secrets), secret package grants, and locked-package
-- publish approval. Agents never write grants; only the signed-in owner UI does.
-- Fingerprint is an exact destination consent pin (method + url + headers +
-- body + auth mode), not a hostname allowlist.

CREATE TABLE webhook_apply_destination_pending (
	user_id TEXT NOT NULL,
	webhook_endpoint_id TEXT NOT NULL,
	destination_fingerprint TEXT NOT NULL,
	destination_json TEXT NOT NULL,
	package_id TEXT NOT NULL,
	webhook_name TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, webhook_endpoint_id, destination_fingerprint),
	FOREIGN KEY (webhook_endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

CREATE INDEX idx_webhook_apply_destination_pending_user
	ON webhook_apply_destination_pending(user_id, updated_at);

CREATE TABLE webhook_apply_destination_grants (
	user_id TEXT NOT NULL,
	webhook_endpoint_id TEXT NOT NULL,
	destination_fingerprint TEXT NOT NULL,
	destination_json TEXT NOT NULL,
	package_id TEXT NOT NULL,
	webhook_name TEXT NOT NULL,
	approved_at TEXT NOT NULL,
	PRIMARY KEY (user_id, webhook_endpoint_id, destination_fingerprint),
	FOREIGN KEY (webhook_endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

CREATE INDEX idx_webhook_apply_destination_grants_user
	ON webhook_apply_destination_grants(user_id, approved_at);
