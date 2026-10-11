-- Durable delivery queue for org audit events (AUDIT_DB). Rows are written on
-- APP_DB with access mutations and drained by the org_audit_outbox scheduled
-- lane (and inline after enqueue when AUDIT_DB is healthy).

CREATE TABLE IF NOT EXISTS org_audit_outbox (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	payload_json TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_org_audit_outbox_created_at
	ON org_audit_outbox (created_at);
