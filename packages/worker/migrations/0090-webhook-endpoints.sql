-- Per-user inbound webhook endpoints that dispatch to a bound saved-package
-- export. URL secrets are stored as hashes only; optional HMAC verification
-- secrets live encrypted inside verification_config JSON.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	package_id TEXT NOT NULL,
	export_name TEXT NOT NULL,
	url_secret_hash TEXT NOT NULL,
	verification_config TEXT,
	response_mode TEXT NOT NULL DEFAULT 'ack' CHECK (response_mode IN ('ack', 'sync')),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_endpoints_user_name
ON webhook_endpoints(user_id, name);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user_created_at
ON webhook_endpoints(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user_id_id
ON webhook_endpoints(user_id, id);

-- Debug log of ingress outcomes. Payload bodies are never stored.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
	id TEXT PRIMARY KEY,
	endpoint_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	received_at TEXT NOT NULL,
	outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'rejected', 'failed')),
	http_status INTEGER NOT NULL,
	error TEXT,
	payload_bytes INTEGER NOT NULL DEFAULT 0,
	FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint_received_at
ON webhook_deliveries(endpoint_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_user_received_at
ON webhook_deliveries(user_id, received_at DESC);
