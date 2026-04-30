PRAGMA foreign_keys = OFF;
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

CREATE TABLE email_inbox_addresses_next (
	id TEXT PRIMARY KEY,
	inbox_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	address TEXT NOT NULL,
	local_part TEXT NOT NULL,
	domain TEXT NOT NULL,
	reply_token_hash TEXT,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes_next(id) ON DELETE CASCADE
);

INSERT INTO email_inbox_addresses_next (
	id,
	inbox_id,
	user_id,
	address,
	local_part,
	domain,
	reply_token_hash,
	enabled,
	created_at,
	updated_at
)
SELECT
	id,
	inbox_id,
	user_id,
	address,
	local_part,
	domain,
	reply_token_hash,
	enabled,
	created_at,
	updated_at
FROM email_inbox_addresses;

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

CREATE TABLE email_attachments_next (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL,
	filename TEXT,
	content_type TEXT NOT NULL,
	content_id TEXT,
	disposition TEXT,
	size INTEGER NOT NULL DEFAULT 0,
	storage_kind TEXT NOT NULL CHECK (storage_kind IN ('raw-mime', 'external', 'unavailable')),
	storage_key TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (message_id) REFERENCES email_messages_next(id) ON DELETE CASCADE
);

INSERT INTO email_attachments_next (
	id,
	message_id,
	filename,
	content_type,
	content_id,
	disposition,
	size,
	storage_kind,
	storage_key,
	created_at
)
SELECT
	id,
	message_id,
	filename,
	content_type,
	content_id,
	disposition,
	size,
	storage_kind,
	storage_key,
	created_at
FROM email_attachments;

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
		WHERE existing.message_id = email_delivery_events.message_id
			AND existing.event_type IN ('received', 'quarantined')
	);

DROP TABLE email_delivery_events;
DROP TABLE email_attachments;
DROP TABLE email_messages;
DROP TABLE IF EXISTS email_sender_policies;
DROP TABLE email_inbox_addresses;
DROP TABLE email_inboxes;

ALTER TABLE email_inboxes_next RENAME TO email_inboxes;
ALTER TABLE email_inbox_addresses_next RENAME TO email_inbox_addresses;
ALTER TABLE email_messages_next RENAME TO email_messages;
ALTER TABLE email_attachments_next RENAME TO email_attachments;
ALTER TABLE email_delivery_events_next RENAME TO email_delivery_events;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_inboxes_user_name
ON email_inboxes(user_id, name);

CREATE INDEX IF NOT EXISTS idx_email_inboxes_user_created_at
ON email_inboxes(user_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_inbox_addresses_address
ON email_inbox_addresses(address);

CREATE INDEX IF NOT EXISTS idx_email_inbox_addresses_inbox_id
ON email_inbox_addresses(inbox_id);

CREATE INDEX IF NOT EXISTS idx_email_inbox_addresses_reply_token
ON email_inbox_addresses(reply_token_hash);

CREATE INDEX IF NOT EXISTS idx_email_messages_user_created_at
ON email_messages(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_inbox_created_at
ON email_messages(inbox_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread_created_at
ON email_messages(thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_message_id_header
ON email_messages(message_id_header);

CREATE INDEX IF NOT EXISTS idx_email_attachments_message_id
ON email_attachments(message_id);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_message_id
ON email_delivery_events(message_id);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_user_created_at
ON email_delivery_events(user_id, created_at);

PRAGMA defer_foreign_keys = OFF;
PRAGMA foreign_keys = ON;
