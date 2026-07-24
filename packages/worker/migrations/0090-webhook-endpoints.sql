-- Per-user minted URL state for package.json#kody.webhooks declarations.
-- Declaring a webhook in the manifest does not open ingress; minting a URL
-- secret does. Verification secrets are never stored here — they are resolved
-- by secretName from the user's secret store at delivery time.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	webhook_name TEXT NOT NULL,
	url_secret_hash TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL,
	rotated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_endpoints_user_package_name
ON webhook_endpoints(user_id, package_id, webhook_name);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user_created_at
ON webhook_endpoints(user_id, created_at);

-- Debug log of ingress outcomes. Payload bodies are never stored.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
	id TEXT PRIMARY KEY,
	endpoint_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	package_id TEXT NOT NULL,
	webhook_name TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_user_package_name_received_at
ON webhook_deliveries(user_id, package_id, webhook_name, received_at DESC);
