PRAGMA defer_foreign_keys = ON;

CREATE TABLE email_inboxes_next (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

INSERT INTO email_inboxes_next (
	id,
	user_id,
	package_id,
	name,
	description,
	enabled,
	created_at,
	updated_at
)
SELECT
	id,
	user_id,
	package_id,
	name,
	description,
	enabled,
	created_at,
	updated_at
FROM email_inboxes;

DROP TABLE email_inboxes;
ALTER TABLE email_inboxes_next RENAME TO email_inboxes;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_inboxes_user_name
ON email_inboxes(user_id, name);

CREATE INDEX IF NOT EXISTS idx_email_inboxes_user_created_at
ON email_inboxes(user_id, created_at);

CREATE TABLE email_messages_next (
	id TEXT PRIMARY KEY,
	direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
	user_id TEXT NOT NULL,
	inbox_id TEXT,
	thread_id TEXT,
	sender_identity_id TEXT,
	from_address TEXT NOT NULL,
	envelope_from TEXT,
	to_addresses_json TEXT NOT NULL DEFAULT '[]',
	cc_addresses_json TEXT NOT NULL DEFAULT '[]',
	bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
	reply_to_addresses_json TEXT NOT NULL DEFAULT '[]',
	subject TEXT NOT NULL DEFAULT '',
	message_id_header TEXT,
	in_reply_to_header TEXT,
	references_json TEXT NOT NULL DEFAULT '[]',
	headers_json TEXT NOT NULL DEFAULT '{}',
	auth_results TEXT,
	text_body TEXT,
	html_body TEXT,
	raw_mime TEXT,
	raw_size INTEGER NOT NULL DEFAULT 0,
	processing_status TEXT NOT NULL CHECK (processing_status IN ('stored', 'sent', 'failed')),
	provider_message_id TEXT,
	error TEXT,
	received_at TEXT,
	sent_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL,
	FOREIGN KEY (thread_id) REFERENCES email_threads(id) ON DELETE SET NULL,
	FOREIGN KEY (sender_identity_id) REFERENCES email_sender_identities(id) ON DELETE SET NULL
);

INSERT INTO email_messages_next (
	id,
	direction,
	user_id,
	inbox_id,
	thread_id,
	sender_identity_id,
	from_address,
	envelope_from,
	to_addresses_json,
	cc_addresses_json,
	bcc_addresses_json,
	reply_to_addresses_json,
	subject,
	message_id_header,
	in_reply_to_header,
	references_json,
	headers_json,
	auth_results,
	text_body,
	html_body,
	raw_mime,
	raw_size,
	processing_status,
	provider_message_id,
	error,
	received_at,
	sent_at,
	created_at,
	updated_at
)
SELECT
	id,
	direction,
	user_id,
	inbox_id,
	thread_id,
	sender_identity_id,
	from_address,
	envelope_from,
	to_addresses_json,
	cc_addresses_json,
	bcc_addresses_json,
	reply_to_addresses_json,
	subject,
	message_id_header,
	in_reply_to_header,
	references_json,
	headers_json,
	auth_results,
	text_body,
	html_body,
	raw_mime,
	raw_size,
	CASE
		WHEN processing_status = 'rejected' THEN 'failed'
		ELSE processing_status
	END AS processing_status,
	provider_message_id,
	error,
	received_at,
	sent_at,
	created_at,
	updated_at
FROM email_messages;

DROP TABLE email_messages;
ALTER TABLE email_messages_next RENAME TO email_messages;

CREATE INDEX IF NOT EXISTS idx_email_messages_user_created_at
ON email_messages(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_inbox_created_at
ON email_messages(inbox_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread_created_at
ON email_messages(thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_message_id_header
ON email_messages(message_id_header);

DROP TABLE IF EXISTS email_sender_policies;

CREATE TABLE email_delivery_events_next (
	id TEXT PRIMARY KEY,
	message_id TEXT,
	user_id TEXT,
	inbox_id TEXT,
	event_type TEXT NOT NULL CHECK (event_type IN ('receive_started', 'received', 'rejected', 'send_requested', 'sent', 'failed')),
	provider TEXT NOT NULL DEFAULT 'kody',
	provider_message_id TEXT,
	detail_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE SET NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL
);

INSERT INTO email_delivery_events_next (
	id,
	message_id,
	user_id,
	inbox_id,
	event_type,
	provider,
	provider_message_id,
	detail_json,
	created_at
)
SELECT
	id,
	message_id,
	user_id,
	inbox_id,
	CASE
		WHEN event_type = 'quarantined' THEN 'received'
		WHEN event_type = 'policy_matched' THEN 'received'
		ELSE event_type
	END AS event_type,
	provider,
	provider_message_id,
	detail_json,
	created_at
FROM email_delivery_events
WHERE event_type != 'policy_matched'
	OR NOT EXISTS (
		SELECT 1
		FROM email_delivery_events existing
		WHERE existing.id = email_delivery_events.id
			AND existing.event_type = 'policy_matched'
	);

DROP TABLE email_delivery_events;
ALTER TABLE email_delivery_events_next RENAME TO email_delivery_events;

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_message_id
ON email_delivery_events(message_id);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_user_created_at
ON email_delivery_events(user_id, created_at);

PRAGMA defer_foreign_keys = OFF;
