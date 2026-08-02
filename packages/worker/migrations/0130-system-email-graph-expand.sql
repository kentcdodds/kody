-- Step 4a expand boundary for operator-owned email. The dedicated graph is an
-- additive copy only: legacy system:email rows remain live authority and the
-- existing outbound provider index remains anchored to legacy email_messages.

CREATE TABLE IF NOT EXISTS system_email_threads (
	id TEXT PRIMARY KEY,
	inbox_id TEXT,
	subject_normalized TEXT NOT NULL DEFAULT '',
	root_message_id_header TEXT,
	last_message_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_system_email_threads_last_message_at
ON system_email_threads(last_message_at);

CREATE INDEX IF NOT EXISTS idx_system_email_threads_root_message_id
ON system_email_threads(root_message_id_header);

CREATE TABLE IF NOT EXISTS system_email_messages (
	id TEXT PRIMARY KEY,
	direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
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
	raw_size INTEGER NOT NULL DEFAULT 0,
	processing_status TEXT NOT NULL CHECK (
		processing_status IN ('stored', 'sent', 'failed')
	),
	provider_message_id TEXT,
	error TEXT,
	received_at TEXT,
	sent_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	raw_mime_key TEXT,
	delivery_status TEXT CHECK (
		delivery_status IS NULL
		OR delivery_status IN (
			'delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained'
		)
	),
	delivery_status_at TEXT,
	classification TEXT NOT NULL DEFAULT 'accepted'
		CHECK (classification IN ('accepted', 'quarantined')),
	classification_reason TEXT,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL,
	FOREIGN KEY (thread_id) REFERENCES system_email_threads(id) ON DELETE SET NULL,
	FOREIGN KEY (sender_identity_id) REFERENCES email_sender_identities(id)
		ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_system_email_messages_created_at
ON system_email_messages(created_at);

CREATE INDEX IF NOT EXISTS idx_system_email_messages_inbox_created_at
ON system_email_messages(inbox_id, created_at);

CREATE INDEX IF NOT EXISTS idx_system_email_messages_thread_created_at
ON system_email_messages(thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_system_email_messages_message_id_header
ON system_email_messages(message_id_header);

CREATE UNIQUE INDEX IF NOT EXISTS idx_system_email_messages_provider_message_id
ON system_email_messages(provider_message_id)
WHERE direction = 'outbound' AND provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_system_email_messages_quarantined_created_at
ON system_email_messages(created_at)
WHERE classification = 'quarantined';

CREATE TABLE IF NOT EXISTS system_email_attachments (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL,
	filename TEXT,
	content_type TEXT NOT NULL,
	content_id TEXT,
	disposition TEXT,
	size INTEGER NOT NULL DEFAULT 0,
	storage_kind TEXT NOT NULL CHECK (
		storage_kind IN ('raw-mime', 'external', 'unavailable')
	),
	storage_key TEXT,
	created_at TEXT NOT NULL,
	FOREIGN KEY (message_id) REFERENCES system_email_messages(id)
		ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_system_email_attachments_message_id
ON system_email_attachments(message_id);

CREATE TABLE IF NOT EXISTS system_email_delivery_events (
	id TEXT PRIMARY KEY,
	message_id TEXT,
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
	created_at TEXT NOT NULL,
	needs_effect_reconcile INTEGER NOT NULL DEFAULT 1
		CHECK (needs_effect_reconcile IN (0, 1)),
	usage_effect_recorded_at TEXT,
	usage_month TEXT,
	usage_bytes INTEGER,
	usage_duration_ms INTEGER,
	state TEXT CHECK (
		state IS NULL
		OR state IN (
			'pending', 'storing', 'cleaning', 'received', 'rejected',
			'orphan-cleaned'
		)
	),
	fingerprint TEXT,
	storage_lease TEXT,
	storage_lease_at TEXT,
	cleanup_lease TEXT,
	cleanup_lease_at TEXT,
	cleanup_retry_at TEXT,
	expected_attachment_count INTEGER,
	finalization_token TEXT,
	reconcile_after TEXT,
	dedupe_expires_at TEXT,
	usage_effect_suppressed_at TEXT,
	usage_started_at TEXT,
	usage_effect_retry_at TEXT,
	usage_effect_lease TEXT,
	usage_effect_lease_at TEXT,
	subscription_effect_state TEXT CHECK (
		subscription_effect_state IS NULL
		OR subscription_effect_state IN (
			'pending', 'processing', 'complete', 'dead-letter'
		)
	),
	subscription_effect_lease TEXT,
	subscription_effect_lease_at TEXT,
	subscription_effect_retry_at TEXT,
	subscription_effect_attempt_count INTEGER,
	subscription_effect_dead_letter_at TEXT,
	subscription_effect_last_error TEXT,
	updated_at TEXT,
	FOREIGN KEY (message_id) REFERENCES system_email_messages(id)
		ON DELETE SET NULL,
	FOREIGN KEY (inbox_id) REFERENCES email_inboxes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_system_email_delivery_events_message_id
ON system_email_delivery_events(message_id);

CREATE INDEX IF NOT EXISTS idx_system_email_delivery_events_created_at
ON system_email_delivery_events(created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_system_email_delivery_events_provider_event_id
ON system_email_delivery_events(provider_event_id)
WHERE provider_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_system_email_delivery_events_provider_event_created
ON system_email_delivery_events(provider, event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_system_email_delivery_events_pending_effects
ON system_email_delivery_events(created_at)
WHERE provider = 'cloudflare-email-routing'
	AND event_type = 'received'
	AND needs_effect_reconcile = 1;

CREATE INDEX IF NOT EXISTS idx_system_email_delivery_events_recorded_usage_month
ON system_email_delivery_events(usage_month)
WHERE provider = 'cloudflare-email-routing'
	AND event_type = 'received'
	AND usage_effect_recorded_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_system_email_delivery_events_state_created
ON system_email_delivery_events(state, created_at, id)
WHERE provider = 'cloudflare-email-routing' AND state IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_system_email_delivery_events_dedupe_expires
ON system_email_delivery_events(dedupe_expires_at, id)
WHERE provider = 'cloudflare-email-routing-dedupe'
	AND dedupe_expires_at IS NOT NULL;

INSERT OR IGNORE INTO system_email_threads (
	id, inbox_id, subject_normalized, root_message_id_header, last_message_at,
	created_at, updated_at
)
SELECT
	id, inbox_id, subject_normalized, root_message_id_header, last_message_at,
	created_at, updated_at
FROM email_threads
WHERE user_id = 'system:email'
	AND (
		inbox_id IS NULL
		OR EXISTS (
			SELECT 1
			FROM email_inboxes inbox
			WHERE inbox.id = email_threads.inbox_id
				AND inbox.user_id = 'system:email'
		)
	);

INSERT OR IGNORE INTO system_email_messages (
	id, direction, inbox_id, thread_id, sender_identity_id, from_address,
	envelope_from, to_addresses_json, cc_addresses_json, bcc_addresses_json,
	reply_to_addresses_json, subject, message_id_header, in_reply_to_header,
	references_json, headers_json, auth_results, text_body, html_body, raw_size,
	processing_status, provider_message_id, error, received_at, sent_at,
	created_at, updated_at, raw_mime_key, delivery_status, delivery_status_at,
	classification, classification_reason
)
SELECT
	id, direction, inbox_id, thread_id, sender_identity_id, from_address,
	envelope_from, to_addresses_json, cc_addresses_json, bcc_addresses_json,
	reply_to_addresses_json, subject, message_id_header, in_reply_to_header,
	references_json, headers_json, auth_results, text_body, html_body, raw_size,
	processing_status, provider_message_id, error, received_at, sent_at,
	created_at, updated_at, raw_mime_key, delivery_status, delivery_status_at,
	classification, classification_reason
FROM email_messages
WHERE user_id = 'system:email'
	AND (
		inbox_id IS NULL
		OR EXISTS (
			SELECT 1
			FROM email_inboxes inbox
			WHERE inbox.id = email_messages.inbox_id
				AND inbox.user_id = 'system:email'
		)
	)
	AND (
		sender_identity_id IS NULL
		OR EXISTS (
			SELECT 1
			FROM email_sender_identities sender
			WHERE sender.id = email_messages.sender_identity_id
				AND sender.user_id = 'system:email'
		)
	)
	AND (
		thread_id IS NULL
		OR EXISTS (
			SELECT 1
			FROM system_email_threads thread
			WHERE thread.id = email_messages.thread_id
		)
	);

INSERT OR IGNORE INTO system_email_attachments (
	id, message_id, filename, content_type, content_id, disposition, size,
	storage_kind, storage_key, created_at
)
SELECT
	attachment.id, attachment.message_id, attachment.filename,
	attachment.content_type, attachment.content_id, attachment.disposition,
	attachment.size, attachment.storage_kind, attachment.storage_key,
	attachment.created_at
FROM email_attachments attachment
INNER JOIN email_messages message ON message.id = attachment.message_id
INNER JOIN system_email_messages system_message
	ON system_message.id = attachment.message_id
WHERE message.user_id = 'system:email';

INSERT OR IGNORE INTO system_email_delivery_events (
	id, message_id, inbox_id, event_type, provider, provider_message_id,
	provider_event_id, detail_json, created_at, needs_effect_reconcile,
	usage_effect_recorded_at, usage_month, usage_bytes, usage_duration_ms, state,
	fingerprint, storage_lease, storage_lease_at, cleanup_lease, cleanup_lease_at,
	cleanup_retry_at, expected_attachment_count, finalization_token,
	reconcile_after, dedupe_expires_at, usage_effect_suppressed_at,
	usage_started_at, usage_effect_retry_at, usage_effect_lease,
	usage_effect_lease_at, subscription_effect_state,
	subscription_effect_lease, subscription_effect_lease_at,
	subscription_effect_retry_at, subscription_effect_attempt_count,
	subscription_effect_dead_letter_at, subscription_effect_last_error, updated_at
)
SELECT
	id, message_id, inbox_id, event_type, provider, provider_message_id,
	provider_event_id, detail_json, created_at, needs_effect_reconcile,
	usage_effect_recorded_at, usage_month, usage_bytes, usage_duration_ms, state,
	fingerprint, storage_lease, storage_lease_at, cleanup_lease, cleanup_lease_at,
	cleanup_retry_at, expected_attachment_count, finalization_token,
	reconcile_after, dedupe_expires_at, usage_effect_suppressed_at,
	usage_started_at, usage_effect_retry_at, usage_effect_lease,
	usage_effect_lease_at, subscription_effect_state,
	subscription_effect_lease, subscription_effect_lease_at,
	subscription_effect_retry_at, subscription_effect_attempt_count,
	subscription_effect_dead_letter_at, subscription_effect_last_error, updated_at
FROM email_delivery_events
WHERE user_id = 'system:email'
	AND (
		inbox_id IS NULL
		OR EXISTS (
			SELECT 1
			FROM email_inboxes inbox
			WHERE inbox.id = email_delivery_events.inbox_id
				AND inbox.user_id = 'system:email'
		)
	)
	AND (
		message_id IS NULL
		OR EXISTS (
			SELECT 1
			FROM system_email_messages message
			WHERE message.id = email_delivery_events.message_id
		)
	);
