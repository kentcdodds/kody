-- Final Mailbox contract boundary. This migration is intentionally destructive
-- and fail-closed. Operators must create and populate
-- email_user_graph_drop_approval directly after taking and verifying a fresh
-- production backup; see docs/contributing/mailbox-legacy-graph-drop.md.
--
-- Wrangler applies this file and its d1_migrations ledger write atomically.
-- Every preflight check therefore runs before the first destructive statement.
CREATE TABLE migration_0134_legacy_email_graph_drop_guard (
	value INTEGER NOT NULL CHECK (value = 1)
);

-- Approval must be current, well formed, and bound to the deployed authority
-- freeze. julianday compares instants and returns NULL for malformed values.
INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM email_user_graph_drop_approval approval
INNER JOIN email_user_graph_authority authority
	ON authority.singleton = approval.singleton
WHERE approval.singleton = 1
	AND approval.authority_frozen_at = authority.frozen_at
	AND approval.owner_count = authority.owner_count
	AND length(trim(approval.backup_object_key)) > 0
	AND length(approval.backup_sha256) = 64
	AND approval.backup_sha256 = lower(approval.backup_sha256)
	AND approval.backup_sha256 NOT GLOB '*[^0-9a-f]*'
	AND julianday(approval.verified_at) IS NOT NULL
	AND julianday(approval.expires_at) IS NOT NULL
	AND julianday(approval.verified_at) <= julianday('now')
	AND julianday(approval.expires_at) > julianday('now');

-- The authority marker must still describe exactly the distinct frozen USER
-- owners. system:email is checked separately against its dedicated authority.
INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
WITH frozen_user_owners(user_id) AS (
	SELECT user_id FROM email_threads WHERE user_id != 'system:email'
	UNION
	SELECT user_id FROM email_messages WHERE user_id != 'system:email'
	UNION
	SELECT user_id FROM email_delivery_events WHERE user_id != 'system:email'
)
SELECT CASE WHEN authority.owner_count = COUNT(owner.user_id) THEN 1 ELSE 0 END
FROM email_user_graph_authority authority
LEFT JOIN frozen_user_owners owner ON TRUE
WHERE authority.singleton = 1
GROUP BY authority.owner_count;

-- Approval counts are an exact manifest of the frozen USER graph represented
-- by the verified backup checksum.
INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	approval.thread_count = (
		SELECT COUNT(*) FROM email_threads WHERE user_id != 'system:email'
	)
	AND approval.message_count = (
		SELECT COUNT(*) FROM email_messages WHERE user_id != 'system:email'
	)
	AND approval.attachment_count = (
		SELECT COUNT(*)
		FROM email_attachments attachment
		INNER JOIN email_messages message ON message.id = attachment.message_id
		WHERE message.user_id != 'system:email'
	)
	AND approval.delivery_event_count = (
		SELECT COUNT(*) FROM email_delivery_events
		WHERE user_id != 'system:email'
	)
THEN 1 ELSE 0 END
FROM email_user_graph_drop_approval approval
WHERE approval.singleton = 1;

-- No provider-index repair may be pending. Live/future inbound hints are valid;
-- only the one-time cutover-audit backlog must be empty.
INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	NOT EXISTS (SELECT 1 FROM email_outbound_provider_index_repair_owners)
	AND NOT EXISTS (
		SELECT 1 FROM email_inbound_due_owners WHERE reason = 'cutover-audit'
	)
THEN 1 ELSE 0 END;

-- Dedicated system authority and the no-provider-link disposition must remain
-- valid at the destructive boundary.
INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	EXISTS (
		SELECT 1
		FROM system_email_graph_authority authority
		WHERE authority.singleton = 1
			AND authority.authority = 'dedicated'
			AND authority.graph_mismatch_count = 0
			AND authority.provider_link_count = 0
	)
	AND NOT EXISTS (
		SELECT 1 FROM email_outbound_provider_index
		WHERE user_id = 'system:email'
	)
	AND NOT EXISTS (
		SELECT 1 FROM email_messages
		WHERE user_id = 'system:email' AND provider_message_id IS NOT NULL
	)
	AND NOT EXISTS (
		SELECT 1 FROM system_email_messages
		WHERE provider_message_id IS NOT NULL
	)
THEN 1 ELSE 0 END;

-- Exact legacy/dedicated system graph parity, including complete row values.
INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	(SELECT COUNT(*) FROM email_threads WHERE user_id = 'system:email') =
		(SELECT COUNT(*) FROM system_email_threads)
	AND NOT EXISTS (
		SELECT 1
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
	)
	AND NOT EXISTS (
		SELECT 1 FROM email_threads legacy
		WHERE legacy.user_id = 'system:email' AND NOT EXISTS (
			SELECT 1 FROM system_email_threads dedicated
			WHERE dedicated.id = legacy.id
		)
	)
	AND NOT EXISTS (
		SELECT 1 FROM system_email_threads dedicated
		WHERE NOT EXISTS (
			SELECT 1 FROM email_threads legacy
			WHERE legacy.id = dedicated.id AND legacy.user_id = 'system:email'
		)
	)
THEN 1 ELSE 0 END;

INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	(SELECT COUNT(*) FROM email_messages WHERE user_id = 'system:email') =
		(SELECT COUNT(*) FROM system_email_messages)
	AND NOT EXISTS (
		SELECT 1
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
	)
	AND NOT EXISTS (
		SELECT 1 FROM email_messages legacy
		WHERE legacy.user_id = 'system:email' AND NOT EXISTS (
			SELECT 1 FROM system_email_messages dedicated
			WHERE dedicated.id = legacy.id
		)
	)
	AND NOT EXISTS (
		SELECT 1 FROM system_email_messages dedicated
		WHERE NOT EXISTS (
			SELECT 1 FROM email_messages legacy
			WHERE legacy.id = dedicated.id AND legacy.user_id = 'system:email'
		)
	)
THEN 1 ELSE 0 END;

INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	(
		SELECT COUNT(*)
		FROM email_attachments attachment
		INNER JOIN email_messages owner ON owner.id = attachment.message_id
		WHERE owner.user_id = 'system:email'
	) = (SELECT COUNT(*) FROM system_email_attachments)
	AND NOT EXISTS (
		SELECT 1
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
	)
	AND NOT EXISTS (
		SELECT 1
		FROM email_attachments legacy
		INNER JOIN email_messages owner ON owner.id = legacy.message_id
		WHERE owner.user_id = 'system:email' AND NOT EXISTS (
			SELECT 1 FROM system_email_attachments dedicated
			WHERE dedicated.id = legacy.id
		)
	)
	AND NOT EXISTS (
		SELECT 1 FROM system_email_attachments dedicated
		WHERE NOT EXISTS (
			SELECT 1
			FROM email_attachments legacy
			INNER JOIN email_messages owner ON owner.id = legacy.message_id
			WHERE legacy.id = dedicated.id AND owner.user_id = 'system:email'
		)
	)
THEN 1 ELSE 0 END;

INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	(SELECT COUNT(*) FROM email_delivery_events WHERE user_id = 'system:email') =
		(SELECT COUNT(*) FROM system_email_delivery_events)
	AND NOT EXISTS (
		SELECT 1
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
	)
	AND NOT EXISTS (
		SELECT 1 FROM email_delivery_events legacy
		WHERE legacy.user_id = 'system:email' AND NOT EXISTS (
			SELECT 1 FROM system_email_delivery_events dedicated
			WHERE dedicated.id = legacy.id
		)
	)
	AND NOT EXISTS (
		SELECT 1 FROM system_email_delivery_events dedicated
		WHERE NOT EXISTS (
			SELECT 1 FROM email_delivery_events legacy
			WHERE legacy.id = dedicated.id AND legacy.user_id = 'system:email'
		)
	)
THEN 1 ELSE 0 END;

-- No unexpected schema object may retain a live dependency on the graph.
INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM sqlite_schema
WHERE type IN ('view', 'trigger')
	AND name != 'email_messages_delete_outbound_provider_index'
	AND (
		lower(sql) LIKE '%email_threads%'
		OR lower(sql) LIKE '%email_messages%'
		OR lower(sql) LIKE '%email_attachments%'
		OR lower(sql) LIKE '%email_delivery_events%'
	);

INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM sqlite_schema
WHERE type = 'table'
	AND name NOT IN (
		'email_threads',
		'email_messages',
		'email_attachments',
		'email_delivery_events',
		'email_inbound_usage_effects'
	)
	AND (
		lower(sql) LIKE '%references email_threads%'
		OR lower(sql) LIKE '%references email_messages%'
		OR lower(sql) LIKE '%references email_attachments%'
		OR lower(sql) LIKE '%references email_delivery_events%'
	);

INSERT INTO migration_0134_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM pragma_foreign_key_check;

-- Preserve the stable cutover audit marker, but remove its retired parity
-- policy field and bind it to the backup that authorized this drop.
CREATE TABLE email_user_graph_authority_next (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	owner_count INTEGER NOT NULL CHECK (owner_count >= 0),
	frozen_at TEXT NOT NULL,
	dropped_at TEXT NOT NULL,
	backup_object_key TEXT NOT NULL,
	backup_sha256 TEXT NOT NULL
);

INSERT INTO email_user_graph_authority_next (
	singleton, owner_count, frozen_at, dropped_at, backup_object_key, backup_sha256
)
SELECT
	authority.singleton,
	authority.owner_count,
	authority.frozen_at,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	approval.backup_object_key,
	approval.backup_sha256
FROM email_user_graph_authority authority
INNER JOIN email_user_graph_drop_approval approval
	ON approval.singleton = authority.singleton;

DROP TRIGGER IF EXISTS email_messages_delete_outbound_provider_index;
DROP TABLE email_inbound_usage_effects;
DROP TABLE email_attachments;
DROP TABLE email_delivery_events;
DROP TABLE email_messages;
DROP TABLE email_threads;

DROP INDEX idx_users_mailbox_parity_checked;
ALTER TABLE users DROP COLUMN mailbox_parity_checked_at;
ALTER TABLE users DROP COLUMN mailbox_parity_matching_since;
ALTER TABLE users DROP COLUMN mailbox_parity_mismatch_count;
ALTER TABLE users DROP COLUMN mailbox_parity_last_error;
ALTER TABLE users DROP COLUMN mailbox_parity_content_watermark_at;
ALTER TABLE users DROP COLUMN mailbox_parity_content_replay_upper_at;
ALTER TABLE users DROP COLUMN mailbox_parity_content_replay_cursor_updated_at;
ALTER TABLE users DROP COLUMN mailbox_parity_content_replay_cursor_id;
ALTER TABLE users DROP COLUMN mailbox_parity_message_backfill_cursor_created_at;
ALTER TABLE users DROP COLUMN mailbox_parity_message_backfill_cursor_id;
ALTER TABLE users DROP COLUMN mailbox_parity_message_backfill_completed_at;
ALTER TABLE users DROP COLUMN mailbox_parity_event_backfill_cursor_created_at;
ALTER TABLE users DROP COLUMN mailbox_parity_event_backfill_cursor_id;
ALTER TABLE users DROP COLUMN mailbox_parity_event_backfill_completed_at;

DROP TABLE email_user_graph_authority;
ALTER TABLE email_user_graph_authority_next RENAME TO email_user_graph_authority;
DROP TABLE email_user_graph_drop_approval;
DROP TABLE migration_0134_legacy_email_graph_drop_guard;
