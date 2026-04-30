CREATE TABLE IF NOT EXISTS email_sender_identities (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT,
	email TEXT NOT NULL,
	domain TEXT,
	display_name TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'disabled')),
	verified_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_identities_user_email
ON email_sender_identities(user_id, email);

CREATE INDEX IF NOT EXISTS idx_email_sender_identities_user_domain
ON email_sender_identities(user_id, domain);

CREATE TABLE IF NOT EXISTS email_inboxes (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	mode TEXT NOT NULL CHECK (mode IN ('quarantine', 'accept')),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_inboxes_user_name
ON email_inboxes(user_id, name);

CREATE INDEX IF NOT EXISTS idx_email_inboxes_user_created_at
ON email_inboxes(user_id, created_at);

CREATE TABLE IF NOT EXISTS email_inbox_addresses (
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
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_inbox_addresses_address
ON email_inbox_addresses(address);

CREATE INDEX IF NOT EXISTS idx_email_inbox_addresses_inbox_id
ON email_inbox_addresses(inbox_id);

CREATE INDEX IF NOT EXISTS idx_email_inbox_addresses_reply_token
ON email_inbox_addresses(reply_token_hash);

CREATE TABLE IF NOT EXISTS email_threads (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	inbox_id TEXT,
	subject_normalized TEXT NOT NULL DEFAULT '',
	root_message_id_header TEXT,
	last_message_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_threads_user_last_message_at
ON email_threads(user_id, last_message_at);

CREATE INDEX IF NOT EXISTS idx_email_threads_root_message_id
ON email_threads(root_message_id_header);

CREATE TABLE IF NOT EXISTS email_messages (
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
	policy_decision TEXT NOT NULL CHECK (policy_decision IN ('accepted', 'quarantined', 'rejected')),
	processing_status TEXT NOT NULL CHECK (processing_status IN ('stored', 'sent', 'failed', 'rejected')),
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

CREATE INDEX IF NOT EXISTS idx_email_messages_user_created_at
ON email_messages(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_inbox_created_at
ON email_messages(inbox_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread_created_at
ON email_messages(thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_policy_created_at
ON email_messages(policy_decision, created_at);

CREATE INDEX IF NOT EXISTS idx_email_messages_message_id_header
ON email_messages(message_id_header);

CREATE TABLE IF NOT EXISTS email_attachments (
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
	FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_attachments_message_id
ON email_attachments(message_id);

CREATE TABLE IF NOT EXISTS email_sender_policies (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	inbox_id TEXT,
	package_id TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('sender', 'domain', 'reply_token')),
	value TEXT NOT NULL,
	effect TEXT NOT NULL CHECK (effect IN ('allow', 'quarantine', 'reject')),
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_sender_policies_inbox_kind_value
ON email_sender_policies(inbox_id, kind, value);

CREATE INDEX IF NOT EXISTS idx_email_sender_policies_user_kind_value
ON email_sender_policies(user_id, kind, value);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_policies_user_kind_value_inbox_null_package_null
ON email_sender_policies(user_id, kind, value)
WHERE inbox_id IS NULL AND package_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_policies_user_kind_value_inbox_package_null
ON email_sender_policies(user_id, kind, value, inbox_id)
WHERE inbox_id IS NOT NULL AND package_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_policies_user_kind_value_package_inbox_null
ON email_sender_policies(user_id, kind, value, package_id)
WHERE inbox_id IS NULL AND package_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_policies_user_kind_value_inbox_package
ON email_sender_policies(user_id, kind, value, inbox_id, package_id)
WHERE inbox_id IS NOT NULL AND package_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_delivery_events (
	id TEXT PRIMARY KEY,
	message_id TEXT,
	user_id TEXT,
	inbox_id TEXT,
	event_type TEXT NOT NULL CHECK (event_type IN ('receive_started', 'received', 'quarantined', 'rejected', 'send_requested', 'sent', 'failed', 'policy_matched')),
	provider TEXT NOT NULL DEFAULT 'kody',
	provider_message_id TEXT,
	detail_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL,
	FOREIGN KEY (message_id) REFERENCES email_messages(id) ON DELETE SET NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_message_id
ON email_delivery_events(message_id);

CREATE INDEX IF NOT EXISTS idx_email_delivery_events_user_created_at
ON email_delivery_events(user_id, created_at);
