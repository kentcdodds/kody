import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'

export async function ensureEmailTestSchema(db: D1Database) {
	// Outbound sends increment the entitlement daily counter, so any suite
	// exercising email sends needs the entitlement tables too.
	await ensureEntitlementTestSchema(db)
	const statements = [
		`DROP TABLE IF EXISTS system_email_daily_counters;`,
		`DROP TABLE IF EXISTS email_sender_policies;`,
		`DROP TABLE IF EXISTS email_sender_rules;`,
		`DROP TABLE IF EXISTS email_delivery_events;`,
		`DROP TABLE IF EXISTS email_attachments;`,
		`DROP TABLE IF EXISTS email_messages;`,
		`DROP TABLE IF EXISTS email_threads;`,
		`DROP TABLE IF EXISTS email_inbox_addresses;`,
		`DROP TABLE IF EXISTS email_inboxes;`,
		`DROP TABLE IF EXISTS email_sender_identities;`,
		`CREATE TABLE IF NOT EXISTS email_sender_identities (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT,
	email TEXT NOT NULL,
	domain TEXT,
	display_name TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL CHECK (status IN ('verified')),
	verified_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_identities_user_email
ON email_sender_identities(user_id, email);`,

		`CREATE TABLE IF NOT EXISTS email_inboxes (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	package_id TEXT,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,

		`CREATE TABLE IF NOT EXISTS email_inbox_addresses (
	id TEXT PRIMARY KEY,
	inbox_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	address TEXT NOT NULL UNIQUE,
	local_part TEXT NOT NULL,
	domain TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE CASCADE
);`,

		`CREATE TABLE IF NOT EXISTS email_threads (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	inbox_id TEXT,
	subject_normalized TEXT NOT NULL DEFAULT '',
	root_message_id_header TEXT,
	last_message_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,

		`CREATE TABLE IF NOT EXISTS email_messages (
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
	raw_mime_key TEXT,
	raw_size INTEGER NOT NULL DEFAULT 0,
	processing_status TEXT NOT NULL CHECK (processing_status IN ('stored', 'sent', 'failed')),
	classification TEXT NOT NULL DEFAULT 'accepted' CHECK (classification IN ('accepted', 'quarantined')),
	classification_reason TEXT,
	provider_message_id TEXT,
	delivery_status TEXT CHECK (
		delivery_status IS NULL OR delivery_status IN (
			'delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained'
		)
	),
	delivery_status_at TEXT,
	error TEXT,
	received_at TEXT,
	sent_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,

		`CREATE TABLE IF NOT EXISTS email_sender_rules (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
	value TEXT NOT NULL,
	effect TEXT NOT NULL CHECK (effect IN ('allow', 'block', 'quarantine')),
	note TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sender_rules_user_kind_value
ON email_sender_rules(user_id, kind, value);`,

		`CREATE TABLE IF NOT EXISTS email_attachments (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL,
	filename TEXT,
	content_type TEXT NOT NULL,
	content_id TEXT,
	disposition TEXT,
	size INTEGER NOT NULL DEFAULT 0,
	storage_kind TEXT NOT NULL CHECK (storage_kind IN ('raw-mime', 'external', 'unavailable')),
	storage_key TEXT,
	created_at TEXT NOT NULL
);`,

		`CREATE TABLE IF NOT EXISTS email_delivery_events (
	id TEXT PRIMARY KEY,
	message_id TEXT,
	user_id TEXT,
	inbox_id TEXT,
	event_type TEXT NOT NULL CHECK (
		event_type IN (
			'receive_started', 'received', 'rejected', 'send_requested', 'sent',
			'failed', 'delivered', 'deferred', 'bounced', 'complained'
		)
	),
	provider TEXT NOT NULL DEFAULT 'kody',
	provider_message_id TEXT,
	provider_event_id TEXT,
	detail_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL
);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_messages_provider_message_id
ON email_messages(provider_message_id)
WHERE direction = 'outbound'
	AND provider_message_id IS NOT NULL;`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_delivery_events_provider_event_id
ON email_delivery_events(provider_event_id)
WHERE provider_event_id IS NOT NULL;`,
		`CREATE TABLE IF NOT EXISTS system_email_daily_counters (
	local_part TEXT NOT NULL,
	day TEXT NOT NULL,
	count INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (local_part, day)
);`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
}
