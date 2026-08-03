-- Step 4b authority marker. The dedicated system_email_* graph is now the
-- system:email read/write authority. Legacy shared rows remain atomic rollback
-- mirrors through step 5 and are intentionally not deleted by this migration.

-- Wrangler submits one migration file plus its d1_migrations ledger insert as
-- one D1 multi-statement transaction. The CHECK sentinel below therefore
-- rolls this schema/data migration back as a unit on any preflight violation.
CREATE TABLE IF NOT EXISTS system_email_graph_authority (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	authority TEXT NOT NULL CHECK (authority = 'dedicated'),
	cutover_at TEXT NOT NULL,
	graph_mismatch_count INTEGER NOT NULL CHECK (graph_mismatch_count = 0),
	provider_link_count INTEGER NOT NULL CHECK (provider_link_count = 0)
);

-- Keep idempotency correlation separate from the canonical ISO timestamp.
ALTER TABLE system_email_daily_counters ADD COLUMN operation_token TEXT;

-- D1's SQLite build has a small compound-SELECT limit. Keep every migration
-- check in its own bounded statement; the zero-only CHECK aborts the enclosing
-- Wrangler migration transaction before graph mutation on any violation.
CREATE TABLE system_email_graph_migration_checks (
	name TEXT PRIMARY KEY,
	category TEXT NOT NULL CHECK (category IN ('graph', 'provider')),
	violation_count INTEGER NOT NULL CHECK (violation_count = 0)
);

INSERT INTO system_email_graph_migration_checks
SELECT 'legacy-thread-ownership', 'graph', COUNT(*)
FROM email_threads thread
WHERE thread.user_id = 'system:email'
	AND thread.inbox_id IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM email_inboxes inbox
		WHERE inbox.id = thread.inbox_id AND inbox.user_id = 'system:email'
	);

INSERT INTO system_email_graph_migration_checks
SELECT 'legacy-message-ownership', 'graph', COUNT(*)
FROM email_messages message
WHERE message.user_id = 'system:email' AND (
	(message.inbox_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM email_inboxes inbox
		WHERE inbox.id = message.inbox_id AND inbox.user_id = 'system:email'
	))
	OR (message.sender_identity_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM email_sender_identities sender
		WHERE sender.id = message.sender_identity_id
			AND sender.user_id = 'system:email'
	))
	OR (message.thread_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM email_threads thread
		WHERE thread.id = message.thread_id AND thread.user_id = 'system:email'
	))
);

INSERT INTO system_email_graph_migration_checks
SELECT 'legacy-delivery-ownership', 'graph', COUNT(*)
FROM email_delivery_events event
WHERE event.user_id = 'system:email' AND (
	(event.inbox_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM email_inboxes inbox
		WHERE inbox.id = event.inbox_id AND inbox.user_id = 'system:email'
	))
	OR (event.message_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM email_messages message
		WHERE message.id = event.message_id AND message.user_id = 'system:email'
	))
);

INSERT INTO system_email_graph_migration_checks
SELECT 'provider-index-links', 'provider', COUNT(*)
FROM email_outbound_provider_index provider_index
WHERE provider_index.user_id = 'system:email' OR EXISTS (
	SELECT 1 FROM email_messages message
	WHERE message.id = provider_index.message_id
		AND message.user_id = 'system:email'
);

INSERT INTO system_email_graph_migration_checks
SELECT 'legacy-message-provider-links', 'provider', COUNT(*)
FROM email_messages
WHERE user_id = 'system:email' AND provider_message_id IS NOT NULL;

INSERT INTO system_email_graph_migration_checks
SELECT 'dedicated-message-provider-links', 'provider', COUNT(*)
FROM system_email_messages
WHERE provider_message_id IS NOT NULL;

-- 0130 was a point-in-time copy. Catch up every legacy change made while 4a
-- remained live authority. Delete dedicated drift child-first so foreign-key
-- actions cannot preserve children whose valid legacy parent disappeared.
DELETE FROM system_email_delivery_events
WHERE NOT EXISTS (
	SELECT 1
	FROM email_delivery_events event
	WHERE event.id = system_email_delivery_events.id
		AND event.user_id = 'system:email'
		AND (
			event.inbox_id IS NULL
			OR EXISTS (
				SELECT 1 FROM email_inboxes inbox
				WHERE inbox.id = event.inbox_id
					AND inbox.user_id = 'system:email'
			)
		)
		AND (
			event.message_id IS NULL
			OR EXISTS (
				SELECT 1
				FROM email_messages message
				WHERE message.id = event.message_id
					AND message.user_id = 'system:email'
					AND (
						message.inbox_id IS NULL
						OR EXISTS (
							SELECT 1 FROM email_inboxes inbox
							WHERE inbox.id = message.inbox_id
								AND inbox.user_id = 'system:email'
						)
					)
					AND (
						message.sender_identity_id IS NULL
						OR EXISTS (
							SELECT 1 FROM email_sender_identities sender
							WHERE sender.id = message.sender_identity_id
								AND sender.user_id = 'system:email'
						)
					)
					AND (
						message.thread_id IS NULL
						OR EXISTS (
							SELECT 1 FROM email_threads thread
							WHERE thread.id = message.thread_id
								AND thread.user_id = 'system:email'
								AND (
									thread.inbox_id IS NULL
									OR EXISTS (
										SELECT 1 FROM email_inboxes inbox
										WHERE inbox.id = thread.inbox_id
											AND inbox.user_id = 'system:email'
									)
								)
						)
					)
			)
		)
);

DELETE FROM system_email_attachments
WHERE NOT EXISTS (
	SELECT 1
	FROM email_attachments attachment
	INNER JOIN email_messages message ON message.id = attachment.message_id
	WHERE attachment.id = system_email_attachments.id
		AND message.user_id = 'system:email'
		AND (
			message.inbox_id IS NULL
			OR EXISTS (
				SELECT 1 FROM email_inboxes inbox
				WHERE inbox.id = message.inbox_id
					AND inbox.user_id = 'system:email'
			)
		)
		AND (
			message.sender_identity_id IS NULL
			OR EXISTS (
				SELECT 1 FROM email_sender_identities sender
				WHERE sender.id = message.sender_identity_id
					AND sender.user_id = 'system:email'
			)
		)
		AND (
			message.thread_id IS NULL
			OR EXISTS (
				SELECT 1 FROM email_threads thread
				WHERE thread.id = message.thread_id
					AND thread.user_id = 'system:email'
					AND (
						thread.inbox_id IS NULL
						OR EXISTS (
							SELECT 1 FROM email_inboxes inbox
							WHERE inbox.id = thread.inbox_id
								AND inbox.user_id = 'system:email'
						)
					)
			)
		)
);

DELETE FROM system_email_messages
WHERE NOT EXISTS (
	SELECT 1
	FROM email_messages message
	WHERE message.id = system_email_messages.id
		AND message.user_id = 'system:email'
		AND (
			message.inbox_id IS NULL
			OR EXISTS (
				SELECT 1 FROM email_inboxes inbox
				WHERE inbox.id = message.inbox_id
					AND inbox.user_id = 'system:email'
			)
		)
		AND (
			message.sender_identity_id IS NULL
			OR EXISTS (
				SELECT 1 FROM email_sender_identities sender
				WHERE sender.id = message.sender_identity_id
					AND sender.user_id = 'system:email'
			)
		)
		AND (
			message.thread_id IS NULL
			OR EXISTS (
				SELECT 1 FROM email_threads thread
				WHERE thread.id = message.thread_id
					AND thread.user_id = 'system:email'
					AND (
						thread.inbox_id IS NULL
						OR EXISTS (
							SELECT 1 FROM email_inboxes inbox
							WHERE inbox.id = thread.inbox_id
								AND inbox.user_id = 'system:email'
						)
					)
			)
		)
);

DELETE FROM system_email_threads
WHERE NOT EXISTS (
	SELECT 1
	FROM email_threads thread
	WHERE thread.id = system_email_threads.id
		AND thread.user_id = 'system:email'
		AND (
			thread.inbox_id IS NULL
			OR EXISTS (
				SELECT 1 FROM email_inboxes inbox
				WHERE inbox.id = thread.inbox_id
					AND inbox.user_id = 'system:email'
			)
		)
);

-- Re-copy valid legacy authority parent-first with complete column UPSERTs.
INSERT INTO system_email_threads (
	id, inbox_id, subject_normalized, root_message_id_header, last_message_at,
	created_at, updated_at
)
SELECT
	id, inbox_id, subject_normalized, root_message_id_header, last_message_at,
	created_at, updated_at
FROM email_threads thread
WHERE thread.user_id = 'system:email'
	AND (
		thread.inbox_id IS NULL
		OR EXISTS (
			SELECT 1 FROM email_inboxes inbox
			WHERE inbox.id = thread.inbox_id
				AND inbox.user_id = 'system:email'
		)
	)
ON CONFLICT(id) DO UPDATE SET
	inbox_id = excluded.inbox_id,
	subject_normalized = excluded.subject_normalized,
	root_message_id_header = excluded.root_message_id_header,
	last_message_at = excluded.last_message_at,
	created_at = excluded.created_at,
	updated_at = excluded.updated_at;

INSERT INTO system_email_messages (
	id, direction, inbox_id, thread_id, sender_identity_id, from_address,
	envelope_from, to_addresses_json, cc_addresses_json, bcc_addresses_json,
	reply_to_addresses_json, subject, message_id_header, in_reply_to_header,
	references_json, headers_json, auth_results, text_body, html_body, raw_size,
	processing_status, provider_message_id, error, received_at, sent_at,
	created_at, updated_at, raw_mime_key, delivery_status, delivery_status_at,
	classification, classification_reason
)
SELECT
	message.id, message.direction, message.inbox_id, message.thread_id,
	message.sender_identity_id, message.from_address, message.envelope_from,
	message.to_addresses_json, message.cc_addresses_json,
	message.bcc_addresses_json, message.reply_to_addresses_json, message.subject,
	message.message_id_header, message.in_reply_to_header,
	message.references_json, message.headers_json, message.auth_results,
	message.text_body, message.html_body, message.raw_size,
	message.processing_status, message.provider_message_id, message.error,
	message.received_at, message.sent_at, message.created_at, message.updated_at,
	message.raw_mime_key, message.delivery_status, message.delivery_status_at,
	message.classification, message.classification_reason
FROM email_messages message
WHERE message.user_id = 'system:email'
	AND (
		message.inbox_id IS NULL
		OR EXISTS (
			SELECT 1 FROM email_inboxes inbox
			WHERE inbox.id = message.inbox_id
				AND inbox.user_id = 'system:email'
		)
	)
	AND (
		message.sender_identity_id IS NULL
		OR EXISTS (
			SELECT 1 FROM email_sender_identities sender
			WHERE sender.id = message.sender_identity_id
				AND sender.user_id = 'system:email'
		)
	)
	AND (
		message.thread_id IS NULL
		OR EXISTS (
			SELECT 1 FROM system_email_threads thread
			WHERE thread.id = message.thread_id
		)
	)
ON CONFLICT(id) DO UPDATE SET
	direction = excluded.direction,
	inbox_id = excluded.inbox_id,
	thread_id = excluded.thread_id,
	sender_identity_id = excluded.sender_identity_id,
	from_address = excluded.from_address,
	envelope_from = excluded.envelope_from,
	to_addresses_json = excluded.to_addresses_json,
	cc_addresses_json = excluded.cc_addresses_json,
	bcc_addresses_json = excluded.bcc_addresses_json,
	reply_to_addresses_json = excluded.reply_to_addresses_json,
	subject = excluded.subject,
	message_id_header = excluded.message_id_header,
	in_reply_to_header = excluded.in_reply_to_header,
	references_json = excluded.references_json,
	headers_json = excluded.headers_json,
	auth_results = excluded.auth_results,
	text_body = excluded.text_body,
	html_body = excluded.html_body,
	raw_size = excluded.raw_size,
	processing_status = excluded.processing_status,
	provider_message_id = excluded.provider_message_id,
	error = excluded.error,
	received_at = excluded.received_at,
	sent_at = excluded.sent_at,
	created_at = excluded.created_at,
	updated_at = excluded.updated_at,
	raw_mime_key = excluded.raw_mime_key,
	delivery_status = excluded.delivery_status,
	delivery_status_at = excluded.delivery_status_at,
	classification = excluded.classification,
	classification_reason = excluded.classification_reason;

INSERT INTO system_email_attachments (
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
INNER JOIN system_email_messages dedicated_message
	ON dedicated_message.id = attachment.message_id
WHERE message.user_id = 'system:email'
ON CONFLICT(id) DO UPDATE SET
	message_id = excluded.message_id,
	filename = excluded.filename,
	content_type = excluded.content_type,
	content_id = excluded.content_id,
	disposition = excluded.disposition,
	size = excluded.size,
	storage_kind = excluded.storage_kind,
	storage_key = excluded.storage_key,
	created_at = excluded.created_at;

INSERT INTO system_email_delivery_events (
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
	event.id, event.message_id, event.inbox_id, event.event_type, event.provider,
	event.provider_message_id, event.provider_event_id, event.detail_json,
	event.created_at, event.needs_effect_reconcile,
	event.usage_effect_recorded_at, event.usage_month, event.usage_bytes,
	event.usage_duration_ms, event.state, event.fingerprint, event.storage_lease,
	event.storage_lease_at, event.cleanup_lease, event.cleanup_lease_at,
	event.cleanup_retry_at, event.expected_attachment_count,
	event.finalization_token, event.reconcile_after, event.dedupe_expires_at,
	event.usage_effect_suppressed_at, event.usage_started_at,
	event.usage_effect_retry_at, event.usage_effect_lease,
	event.usage_effect_lease_at, event.subscription_effect_state,
	event.subscription_effect_lease, event.subscription_effect_lease_at,
	event.subscription_effect_retry_at, event.subscription_effect_attempt_count,
	event.subscription_effect_dead_letter_at,
	event.subscription_effect_last_error, event.updated_at
FROM email_delivery_events event
WHERE event.user_id = 'system:email'
	AND (
		event.inbox_id IS NULL
		OR EXISTS (
			SELECT 1 FROM email_inboxes inbox
			WHERE inbox.id = event.inbox_id
				AND inbox.user_id = 'system:email'
		)
	)
	AND (
		event.message_id IS NULL
		OR EXISTS (
			SELECT 1 FROM system_email_messages message
			WHERE message.id = event.message_id
		)
	)
ON CONFLICT(id) DO UPDATE SET
	message_id = excluded.message_id,
	inbox_id = excluded.inbox_id,
	event_type = excluded.event_type,
	provider = excluded.provider,
	provider_message_id = excluded.provider_message_id,
	provider_event_id = excluded.provider_event_id,
	detail_json = excluded.detail_json,
	created_at = excluded.created_at,
	needs_effect_reconcile = excluded.needs_effect_reconcile,
	usage_effect_recorded_at = excluded.usage_effect_recorded_at,
	usage_month = excluded.usage_month,
	usage_bytes = excluded.usage_bytes,
	usage_duration_ms = excluded.usage_duration_ms,
	state = excluded.state,
	fingerprint = excluded.fingerprint,
	storage_lease = excluded.storage_lease,
	storage_lease_at = excluded.storage_lease_at,
	cleanup_lease = excluded.cleanup_lease,
	cleanup_lease_at = excluded.cleanup_lease_at,
	cleanup_retry_at = excluded.cleanup_retry_at,
	expected_attachment_count = excluded.expected_attachment_count,
	finalization_token = excluded.finalization_token,
	reconcile_after = excluded.reconcile_after,
	dedupe_expires_at = excluded.dedupe_expires_at,
	usage_effect_suppressed_at = excluded.usage_effect_suppressed_at,
	usage_started_at = excluded.usage_started_at,
	usage_effect_retry_at = excluded.usage_effect_retry_at,
	usage_effect_lease = excluded.usage_effect_lease,
	usage_effect_lease_at = excluded.usage_effect_lease_at,
	subscription_effect_state = excluded.subscription_effect_state,
	subscription_effect_lease = excluded.subscription_effect_lease,
	subscription_effect_lease_at = excluded.subscription_effect_lease_at,
	subscription_effect_retry_at = excluded.subscription_effect_retry_at,
	subscription_effect_attempt_count =
		excluded.subscription_effect_attempt_count,
	subscription_effect_dead_letter_at =
		excluded.subscription_effect_dead_letter_at,
	subscription_effect_last_error = excluded.subscription_effect_last_error,
	updated_at = excluded.updated_at;

-- After 0129, detail_json remained the legacy system inbound state-machine
-- authority. Promoted columns could therefore be stale, including non-null
-- leases removed from JSON. Normalize inbound and dedupe rows directly from
-- JSON; absent properties intentionally clear to NULL. needs_effect_reconcile
-- remains separately authoritative because every legacy receive/effect
-- transition updates it in the same statement as detail_json.
UPDATE system_email_delivery_events
SET
	usage_effect_recorded_at = json_extract(detail_json, '$.usageEffectRecordedAt'),
	usage_month = json_extract(detail_json, '$.usageMonth'),
	usage_bytes = json_extract(detail_json, '$.usageBytes'),
	usage_duration_ms = json_extract(detail_json, '$.usageDurationMs'),
	state = json_extract(detail_json, '$.state'),
	fingerprint = json_extract(detail_json, '$.fingerprint'),
	storage_lease = json_extract(detail_json, '$.storageLease'),
	storage_lease_at = json_extract(detail_json, '$.storageLeaseAt'),
	cleanup_lease = json_extract(detail_json, '$.cleanupLease'),
	cleanup_lease_at = json_extract(detail_json, '$.cleanupLeaseAt'),
	cleanup_retry_at = json_extract(detail_json, '$.cleanupRetryAt'),
	expected_attachment_count = json_extract(detail_json, '$.expectedAttachmentCount'),
	finalization_token = json_extract(detail_json, '$.finalizationToken'),
	reconcile_after = json_extract(detail_json, '$.reconcileAfter'),
	dedupe_expires_at = json_extract(detail_json, '$.dedupeExpiresAt'),
	usage_effect_suppressed_at = json_extract(detail_json, '$.usageEffectSuppressedAt'),
	usage_started_at = json_extract(detail_json, '$.usageStartedAt'),
	usage_effect_retry_at = json_extract(detail_json, '$.usageEffectRetryAt'),
	usage_effect_lease = json_extract(detail_json, '$.usageEffectLease'),
	usage_effect_lease_at = json_extract(detail_json, '$.usageEffectLeaseAt'),
	subscription_effect_state = json_extract(detail_json, '$.subscriptionEffectState'),
	subscription_effect_lease = json_extract(detail_json, '$.subscriptionEffectLease'),
	subscription_effect_lease_at = json_extract(detail_json, '$.subscriptionEffectLeaseAt'),
	subscription_effect_retry_at = json_extract(detail_json, '$.subscriptionEffectRetryAt'),
	subscription_effect_attempt_count = json_extract(detail_json, '$.subscriptionEffectAttemptCount'),
	subscription_effect_dead_letter_at = json_extract(detail_json, '$.subscriptionEffectDeadLetterAt'),
	subscription_effect_last_error = json_extract(detail_json, '$.subscriptionEffectLastError'),
	updated_at = COALESCE(json_extract(detail_json, '$.updatedAt'), created_at)
WHERE provider IN ('cloudflare-email-routing', 'cloudflare-email-routing-dedupe');

-- The rollback mirror must expose the same canonical promoted projection.
UPDATE email_delivery_events
SET
	usage_effect_recorded_at = json_extract(detail_json, '$.usageEffectRecordedAt'),
	usage_month = json_extract(detail_json, '$.usageMonth'),
	usage_bytes = json_extract(detail_json, '$.usageBytes'),
	usage_duration_ms = json_extract(detail_json, '$.usageDurationMs'),
	state = json_extract(detail_json, '$.state'),
	fingerprint = json_extract(detail_json, '$.fingerprint'),
	storage_lease = json_extract(detail_json, '$.storageLease'),
	storage_lease_at = json_extract(detail_json, '$.storageLeaseAt'),
	cleanup_lease = json_extract(detail_json, '$.cleanupLease'),
	cleanup_lease_at = json_extract(detail_json, '$.cleanupLeaseAt'),
	cleanup_retry_at = json_extract(detail_json, '$.cleanupRetryAt'),
	expected_attachment_count = json_extract(detail_json, '$.expectedAttachmentCount'),
	finalization_token = json_extract(detail_json, '$.finalizationToken'),
	reconcile_after = json_extract(detail_json, '$.reconcileAfter'),
	dedupe_expires_at = json_extract(detail_json, '$.dedupeExpiresAt'),
	usage_effect_suppressed_at = json_extract(detail_json, '$.usageEffectSuppressedAt'),
	usage_started_at = json_extract(detail_json, '$.usageStartedAt'),
	usage_effect_retry_at = json_extract(detail_json, '$.usageEffectRetryAt'),
	usage_effect_lease = json_extract(detail_json, '$.usageEffectLease'),
	usage_effect_lease_at = json_extract(detail_json, '$.usageEffectLeaseAt'),
	subscription_effect_state = json_extract(detail_json, '$.subscriptionEffectState'),
	subscription_effect_lease = json_extract(detail_json, '$.subscriptionEffectLease'),
	subscription_effect_lease_at = json_extract(detail_json, '$.subscriptionEffectLeaseAt'),
	subscription_effect_retry_at = json_extract(detail_json, '$.subscriptionEffectRetryAt'),
	subscription_effect_attempt_count = json_extract(detail_json, '$.subscriptionEffectAttemptCount'),
	subscription_effect_dead_letter_at = json_extract(detail_json, '$.subscriptionEffectDeadLetterAt'),
	subscription_effect_last_error = json_extract(detail_json, '$.subscriptionEffectLastError'),
	updated_at = COALESCE(json_extract(detail_json, '$.updatedAt'), created_at)
WHERE user_id = 'system:email'
	AND provider IN ('cloudflare-email-routing', 'cloudflare-email-routing-dedupe');

-- Validate each table in a separate bounded statement after catch-up and
-- normalization. Every check covers count parity, missing/extra IDs, complete
-- row parity, and dedicated reference ownership where applicable.
INSERT INTO system_email_graph_migration_checks
SELECT 'postcopy-threads', 'graph',
	ABS(
		(SELECT COUNT(*) FROM email_threads WHERE user_id = 'system:email')
		- (SELECT COUNT(*) FROM system_email_threads)
	) + (
		SELECT COUNT(*) FROM email_threads legacy
		WHERE legacy.user_id = 'system:email' AND NOT EXISTS (
			SELECT 1 FROM system_email_threads dedicated
			WHERE dedicated.id = legacy.id
		)
	) + (
		SELECT COUNT(*) FROM system_email_threads dedicated
		WHERE NOT EXISTS (
			SELECT 1 FROM email_threads legacy
			WHERE legacy.id = dedicated.id AND legacy.user_id = 'system:email'
		)
	) + (
		SELECT COUNT(*)
		FROM email_threads legacy
		INNER JOIN system_email_threads dedicated ON dedicated.id = legacy.id
		WHERE legacy.user_id = 'system:email' AND json_array(
			legacy.id, legacy.inbox_id, legacy.subject_normalized,
			legacy.root_message_id_header, legacy.last_message_at,
			legacy.created_at, legacy.updated_at
		) IS NOT json_array(
			dedicated.id, dedicated.inbox_id, dedicated.subject_normalized,
			dedicated.root_message_id_header, dedicated.last_message_at,
			dedicated.created_at, dedicated.updated_at
		)
	) + (
		SELECT COUNT(*) FROM system_email_threads dedicated
		WHERE dedicated.inbox_id IS NOT NULL AND NOT EXISTS (
			SELECT 1 FROM email_inboxes inbox
			WHERE inbox.id = dedicated.inbox_id AND inbox.user_id = 'system:email'
		)
	);

INSERT INTO system_email_graph_migration_checks
SELECT 'postcopy-messages', 'graph',
	ABS(
		(SELECT COUNT(*) FROM email_messages WHERE user_id = 'system:email')
		- (SELECT COUNT(*) FROM system_email_messages)
	) + (
		SELECT COUNT(*) FROM email_messages legacy
		WHERE legacy.user_id = 'system:email' AND NOT EXISTS (
			SELECT 1 FROM system_email_messages dedicated
			WHERE dedicated.id = legacy.id
		)
	) + (
		SELECT COUNT(*) FROM system_email_messages dedicated
		WHERE NOT EXISTS (
			SELECT 1 FROM email_messages legacy
			WHERE legacy.id = dedicated.id AND legacy.user_id = 'system:email'
		)
	) + (
		SELECT COUNT(*)
		FROM email_messages legacy
		INNER JOIN system_email_messages dedicated ON dedicated.id = legacy.id
		WHERE legacy.user_id = 'system:email' AND json_array(
			legacy.id, legacy.direction, legacy.inbox_id, legacy.thread_id,
			legacy.sender_identity_id, legacy.from_address, legacy.envelope_from,
			legacy.to_addresses_json, legacy.cc_addresses_json,
			legacy.bcc_addresses_json, legacy.reply_to_addresses_json,
			legacy.subject, legacy.message_id_header, legacy.in_reply_to_header,
			legacy.references_json, legacy.headers_json, legacy.auth_results,
			legacy.text_body, legacy.html_body, legacy.raw_size,
			legacy.processing_status, legacy.provider_message_id, legacy.error,
			legacy.received_at, legacy.sent_at, legacy.created_at,
			legacy.updated_at, legacy.raw_mime_key, legacy.delivery_status,
			legacy.delivery_status_at, legacy.classification,
			legacy.classification_reason
		) IS NOT json_array(
			dedicated.id, dedicated.direction, dedicated.inbox_id,
			dedicated.thread_id, dedicated.sender_identity_id,
			dedicated.from_address, dedicated.envelope_from,
			dedicated.to_addresses_json, dedicated.cc_addresses_json,
			dedicated.bcc_addresses_json, dedicated.reply_to_addresses_json,
			dedicated.subject, dedicated.message_id_header,
			dedicated.in_reply_to_header, dedicated.references_json,
			dedicated.headers_json, dedicated.auth_results, dedicated.text_body,
			dedicated.html_body, dedicated.raw_size,
			dedicated.processing_status, dedicated.provider_message_id,
			dedicated.error, dedicated.received_at, dedicated.sent_at,
			dedicated.created_at, dedicated.updated_at, dedicated.raw_mime_key,
			dedicated.delivery_status, dedicated.delivery_status_at,
			dedicated.classification, dedicated.classification_reason
		)
	) + (
		SELECT COUNT(*) FROM system_email_messages message
		WHERE
			(message.inbox_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM email_inboxes inbox
				WHERE inbox.id = message.inbox_id AND inbox.user_id = 'system:email'
			))
			OR (message.sender_identity_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM email_sender_identities sender
				WHERE sender.id = message.sender_identity_id
					AND sender.user_id = 'system:email'
			))
			OR (message.thread_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM system_email_threads thread
				WHERE thread.id = message.thread_id
			))
	);

INSERT INTO system_email_graph_migration_checks
SELECT 'postcopy-attachments', 'graph',
	ABS((
		SELECT COUNT(*)
		FROM email_attachments attachment
		INNER JOIN email_messages owner ON owner.id = attachment.message_id
		WHERE owner.user_id = 'system:email'
	) - (SELECT COUNT(*) FROM system_email_attachments)) + (
		SELECT COUNT(*)
		FROM email_attachments legacy
		INNER JOIN email_messages owner ON owner.id = legacy.message_id
		WHERE owner.user_id = 'system:email' AND NOT EXISTS (
			SELECT 1 FROM system_email_attachments dedicated
			WHERE dedicated.id = legacy.id
		)
	) + (
		SELECT COUNT(*) FROM system_email_attachments dedicated
		WHERE NOT EXISTS (
			SELECT 1
			FROM email_attachments legacy
			INNER JOIN email_messages owner ON owner.id = legacy.message_id
			WHERE legacy.id = dedicated.id AND owner.user_id = 'system:email'
		)
	) + (
		SELECT COUNT(*)
		FROM email_attachments legacy
		INNER JOIN email_messages owner ON owner.id = legacy.message_id
		INNER JOIN system_email_attachments dedicated ON dedicated.id = legacy.id
		WHERE owner.user_id = 'system:email' AND json_array(
			legacy.id, legacy.message_id, legacy.filename, legacy.content_type,
			legacy.content_id, legacy.disposition, legacy.size,
			legacy.storage_kind, legacy.storage_key, legacy.created_at
		) IS NOT json_array(
			dedicated.id, dedicated.message_id, dedicated.filename,
			dedicated.content_type, dedicated.content_id,
			dedicated.disposition, dedicated.size, dedicated.storage_kind,
			dedicated.storage_key, dedicated.created_at
		)
	) + (
		SELECT COUNT(*) FROM system_email_attachments attachment
		WHERE NOT EXISTS (
			SELECT 1 FROM system_email_messages message
			WHERE message.id = attachment.message_id
		)
	);

INSERT INTO system_email_graph_migration_checks
SELECT 'postcopy-delivery-events', 'graph',
	ABS(
		(SELECT COUNT(*) FROM email_delivery_events WHERE user_id = 'system:email')
		- (SELECT COUNT(*) FROM system_email_delivery_events)
	) + (
		SELECT COUNT(*) FROM email_delivery_events legacy
		WHERE legacy.user_id = 'system:email' AND NOT EXISTS (
			SELECT 1 FROM system_email_delivery_events dedicated
			WHERE dedicated.id = legacy.id
		)
	) + (
		SELECT COUNT(*) FROM system_email_delivery_events dedicated
		WHERE NOT EXISTS (
			SELECT 1 FROM email_delivery_events legacy
			WHERE legacy.id = dedicated.id AND legacy.user_id = 'system:email'
		)
	) + (
		SELECT COUNT(*)
		FROM email_delivery_events legacy
		INNER JOIN system_email_delivery_events dedicated
			ON dedicated.id = legacy.id
		WHERE legacy.user_id = 'system:email' AND json_array(
			legacy.id, legacy.message_id, legacy.inbox_id, legacy.event_type,
			legacy.provider, legacy.provider_message_id, legacy.provider_event_id,
			legacy.detail_json, legacy.created_at, legacy.needs_effect_reconcile,
			legacy.usage_effect_recorded_at, legacy.usage_month,
			legacy.usage_bytes, legacy.usage_duration_ms, legacy.state,
			legacy.fingerprint, legacy.storage_lease, legacy.storage_lease_at,
			legacy.cleanup_lease, legacy.cleanup_lease_at,
			legacy.cleanup_retry_at, legacy.expected_attachment_count,
			legacy.finalization_token, legacy.reconcile_after,
			legacy.dedupe_expires_at, legacy.usage_effect_suppressed_at,
			legacy.usage_started_at, legacy.usage_effect_retry_at,
			legacy.usage_effect_lease, legacy.usage_effect_lease_at,
			legacy.subscription_effect_state, legacy.subscription_effect_lease,
			legacy.subscription_effect_lease_at,
			legacy.subscription_effect_retry_at,
			legacy.subscription_effect_attempt_count,
			legacy.subscription_effect_dead_letter_at,
			legacy.subscription_effect_last_error, legacy.updated_at
		) IS NOT json_array(
			dedicated.id, dedicated.message_id, dedicated.inbox_id,
			dedicated.event_type, dedicated.provider,
			dedicated.provider_message_id, dedicated.provider_event_id,
			dedicated.detail_json, dedicated.created_at,
			dedicated.needs_effect_reconcile,
			dedicated.usage_effect_recorded_at, dedicated.usage_month,
			dedicated.usage_bytes, dedicated.usage_duration_ms,
			dedicated.state, dedicated.fingerprint, dedicated.storage_lease,
			dedicated.storage_lease_at, dedicated.cleanup_lease,
			dedicated.cleanup_lease_at, dedicated.cleanup_retry_at,
			dedicated.expected_attachment_count,
			dedicated.finalization_token, dedicated.reconcile_after,
			dedicated.dedupe_expires_at,
			dedicated.usage_effect_suppressed_at, dedicated.usage_started_at,
			dedicated.usage_effect_retry_at, dedicated.usage_effect_lease,
			dedicated.usage_effect_lease_at,
			dedicated.subscription_effect_state,
			dedicated.subscription_effect_lease,
			dedicated.subscription_effect_lease_at,
			dedicated.subscription_effect_retry_at,
			dedicated.subscription_effect_attempt_count,
			dedicated.subscription_effect_dead_letter_at,
			dedicated.subscription_effect_last_error, dedicated.updated_at
		)
	) + (
		SELECT COUNT(*) FROM system_email_delivery_events event
		WHERE
			(event.inbox_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM email_inboxes inbox
				WHERE inbox.id = event.inbox_id AND inbox.user_id = 'system:email'
			))
			OR (event.message_id IS NOT NULL AND NOT EXISTS (
				SELECT 1 FROM system_email_messages message
				WHERE message.id = event.message_id
			))
	);

-- All bounded checks have succeeded. Persist their zero totals only now, then
-- remove the migration-only table before committing the cutover.
INSERT INTO system_email_graph_authority (
	singleton, authority, cutover_at, graph_mismatch_count, provider_link_count
)
SELECT
	1,
	'dedicated',
	CURRENT_TIMESTAMP,
	COALESCE(SUM(CASE WHEN category = 'graph' THEN violation_count END), 0),
	COALESCE(SUM(CASE WHEN category = 'provider' THEN violation_count END), 0)
FROM system_email_graph_migration_checks;

DROP TABLE system_email_graph_migration_checks;
