-- Per-user sender allow/block/quarantine rules, plus a classification column
-- on stored messages ('accepted' | 'quarantined') for quarantine listing.

ALTER TABLE email_messages ADD COLUMN classification TEXT NOT NULL DEFAULT 'accepted'
	CHECK (classification IN ('accepted', 'quarantined'));

ALTER TABLE email_messages ADD COLUMN classification_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_email_messages_quarantined_user_created_at
	ON email_messages(user_id, created_at)
	WHERE classification = 'quarantined';

CREATE TABLE IF NOT EXISTS email_sender_rules (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
	value TEXT NOT NULL,
	effect TEXT NOT NULL CHECK (effect IN ('allow', 'block', 'quarantine')),
	note TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_rules_user_kind_value
	ON email_sender_rules(user_id, kind, value);
