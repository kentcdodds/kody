-- Global outbound provider → owner reverse index.
-- email_messages remains authoritative for provider_message_id; this table is a
-- derived lookup so contextless delivery webhooks can resolve the owning user
-- without a full-table provider_message_id scan (and without enumerating
-- per-user Mailbox objects). Backfill includes system:email when present.
-- message_id FK cascades with authoritative message deletes.

CREATE TABLE email_outbound_provider_index (
	provider TEXT NOT NULL,
	provider_message_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	inbox_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (provider, provider_message_id),
	FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE
);

CREATE INDEX idx_email_outbound_provider_index_user_id
	ON email_outbound_provider_index(user_id);

CREATE UNIQUE INDEX idx_email_outbound_provider_index_message_id
	ON email_outbound_provider_index(message_id);

INSERT INTO email_outbound_provider_index (
	provider,
	provider_message_id,
	user_id,
	message_id,
	inbox_id,
	created_at,
	updated_at
)
SELECT
	'cloudflare-email',
	provider_message_id,
	user_id,
	id,
	inbox_id,
	created_at,
	updated_at
FROM email_messages
WHERE direction = 'outbound'
	AND provider_message_id IS NOT NULL;
