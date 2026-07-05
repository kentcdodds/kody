CREATE TABLE IF NOT EXISTS audit_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	category TEXT NOT NULL CHECK (category IN ('account', 'admin', 'auth', 'oauth')),
	action TEXT NOT NULL,
	result TEXT NOT NULL CHECK (result IN ('success', 'failure', 'rate_limited')),
	email_hash TEXT,
	ip_hash TEXT,
	client_id TEXT,
	path TEXT,
	reason TEXT,
	timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp
	ON audit_events(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_action_timestamp
	ON audit_events(action, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_email_hash_timestamp
	ON audit_events(email_hash, timestamp DESC);
