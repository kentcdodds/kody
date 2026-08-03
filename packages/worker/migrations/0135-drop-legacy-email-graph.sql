-- Final Mailbox contract boundary. This migration is destructive and
-- fail-closed. Migration 0134 and the independently deployed backup control
-- plane are the only supported source of email_user_graph_drop_approval.
-- Operators must never manufacture approval rows with direct SQL. A provably
-- empty, never-seeded database may use the explicit bootstrap branch below.
--
-- Wrangler applies this file and its d1_migrations ledger write atomically.
-- Every preflight check therefore runs before the first destructive statement.
CREATE TABLE migration_0135_legacy_email_graph_drop_guard (
	value INTEGER NOT NULL CHECK (value = 1)
);

-- Consume every provenance family in the canonical 0134 approval contract.
-- Any fresh, monotonic control-plane receipt is accepted; request-unique keys
-- bind its signed manifest to the exact SQL object. A database that has never
-- contained email data may bootstrap without manufacturing approval evidence,
-- but only while every legacy, dedicated, coordination, and idempotency surface
-- is still empty.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	EXISTS (SELECT 1 FROM email_user_graph_drop_approval)
	OR (
		NOT EXISTS (SELECT 1 FROM email_user_graph_drop_approval)
		AND EXISTS (
			SELECT 1 FROM email_user_graph_authority
			WHERE singleton = 1 AND owner_count = 0
		)
		AND (SELECT COUNT(*) FROM email_threads) = 0
		AND (SELECT COUNT(*) FROM email_messages) = 0
		AND (SELECT COUNT(*) FROM email_attachments) = 0
		AND (SELECT COUNT(*) FROM email_delivery_events) = 0
		AND (SELECT COUNT(*) FROM email_outbound_provider_index) = 0
		AND (
			SELECT COUNT(*) FROM email_outbound_provider_index_repair_owners
		) = 0
		AND (SELECT COUNT(*) FROM email_inbound_due_owners) = 0
		AND (SELECT COUNT(*) FROM email_inbound_usage_effects) = 0
		AND (SELECT COUNT(*) FROM system_email_threads) = 0
		AND (SELECT COUNT(*) FROM system_email_messages) = 0
		AND (SELECT COUNT(*) FROM system_email_attachments) = 0
		AND (SELECT COUNT(*) FROM system_email_delivery_events) = 0
		AND EXISTS (
			SELECT 1
			FROM system_email_graph_authority
			WHERE singleton = 1
				AND authority = 'dedicated'
				AND graph_mismatch_count = 0
				AND provider_link_count = 0
		)
	)
THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM (
		SELECT 1 AS valid
		FROM email_user_graph_drop_approval approval
		INNER JOIN email_user_graph_authority authority
			ON authority.singleton = approval.singleton
		WHERE approval.singleton = 1
			AND approval.issued_by = 'backup-control-plane'
			AND length(approval.source_account_id) IN (32, 36)
			AND length(approval.source_database_id) = 36
			AND length(approval.source_database_name) BETWEEN 1 AND 128
			AND length(approval.manifest_key_id) BETWEEN 1 AND 128
			AND approval.signature_algorithm = 'Ed25519'
			AND approval.retention_tier = 'daily'
			AND length(approval.restore_baseline_id) BETWEEN 1 AND 128
			AND length(approval.restore_baseline_sha256) = 64
			AND approval.restore_baseline_sha256 =
				lower(approval.restore_baseline_sha256)
			AND approval.restore_baseline_sha256 NOT GLOB '*[^0-9a-f]*'
			AND length(approval.build_commit) BETWEEN 1 AND 128
			AND approval.authority_frozen_at = authority.frozen_at
			AND approval.authority_owner_count = authority.owner_count
			AND approval.owner_count = authority.owner_count
			AND length(approval.request_id) = 36
			AND approval.request_id = lower(approval.request_id)
			AND substr(approval.request_id, 9, 1) = '-'
			AND substr(approval.request_id, 14, 1) = '-'
			AND substr(approval.request_id, 19, 1) = '-'
			AND substr(approval.request_id, 24, 1) = '-'
			AND replace(approval.request_id, '-', '') NOT GLOB '*[^0-9a-f]*'
			AND substr(approval.request_id, 15, 1) GLOB '[1-8]'
			AND substr(approval.request_id, 20, 1) GLOB '[89ab]'
			AND length(approval.nonce) = 32
			AND approval.nonce = lower(approval.nonce)
			AND approval.nonce NOT GLOB '*[^0-9a-f]*'
			AND approval.manifest_key =
				'adhoc/mailbox-drop/d1/' || approval.source_database_id || '/' ||
				replace(
					replace(
						replace(approval.export_scheduled_at, '-', ''),
						':',
						''
					),
					'.',
					''
				) || '-' || approval.nonce || '-' || approval.request_id ||
				'/manifest.json'
			AND approval.sql_object_key =
				substr(
					approval.manifest_key,
					1,
					length(approval.manifest_key) - length('manifest.json')
				) || 'backup-request.sql'
			AND length(approval.sql_sha256) = 64
			AND approval.sql_sha256 = lower(approval.sql_sha256)
			AND approval.sql_sha256 NOT GLOB '*[^0-9a-f]*'
			AND approval.sql_bytes > 0
			AND length(approval.r2_etag) = 32
			AND approval.r2_etag = lower(approval.r2_etag)
			AND approval.r2_etag NOT GLOB '*[^0-9a-f]*'
			AND length(approval.manifest_signature_sha256) = 64
			AND approval.manifest_signature_sha256 =
				lower(approval.manifest_signature_sha256)
			AND approval.manifest_signature_sha256 NOT GLOB '*[^0-9a-f]*'
			AND length(approval.export_bookmark) BETWEEN 1 AND 256
			AND julianday(approval.authority_frozen_at) IS NOT NULL
			AND julianday(approval.export_scheduled_at) IS NOT NULL
			AND julianday(approval.export_started_at) IS NOT NULL
			AND julianday(approval.export_completed_at) IS NOT NULL
			AND julianday(approval.verified_at) IS NOT NULL
			AND julianday(approval.expires_at) IS NOT NULL
			AND approval.authority_frozen_at =
				strftime(
					'%Y-%m-%dT%H:%M:%fZ',
					approval.authority_frozen_at
				)
			AND approval.export_scheduled_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', approval.export_scheduled_at)
			AND approval.export_started_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', approval.export_started_at)
			AND approval.export_completed_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', approval.export_completed_at)
			AND approval.verified_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', approval.verified_at)
			AND approval.expires_at =
				strftime('%Y-%m-%dT%H:%M:%fZ', approval.expires_at)
			AND julianday(approval.export_scheduled_at) >=
				julianday(approval.authority_frozen_at)
			AND julianday(approval.export_started_at) >=
				julianday(approval.export_scheduled_at)
			AND julianday(approval.export_completed_at) >=
				julianday(approval.export_started_at)
			AND julianday(approval.verified_at) >=
				julianday(approval.export_completed_at)
			AND julianday(approval.verified_at) <= julianday('now')
			AND julianday(approval.expires_at) > julianday('now')
			AND julianday(approval.expires_at) >
				julianday(approval.verified_at)
			AND julianday(approval.expires_at) <=
				julianday(approval.verified_at, '+2 hours')
	UNION ALL
	SELECT 1 WHERE NOT EXISTS (
		SELECT 1 FROM email_user_graph_drop_approval
	)
);

-- The authority marker must still describe exactly the distinct frozen USER
-- owners. system:email is checked separately against its dedicated authority.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
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

-- Approval counts are the exact signed manifest of the current frozen USER
-- graph. event_count is the canonical 0134 contract name. The empty bootstrap
-- has no receipt, so reassert its marker and all four shared-table counts here.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	EXISTS (
		SELECT 1
		FROM email_user_graph_drop_approval approval
		WHERE approval.singleton = 1
			AND approval.owner_count = (
				SELECT COUNT(*) FROM (
					SELECT user_id FROM email_threads
					WHERE user_id != 'system:email'
					UNION
					SELECT user_id FROM email_messages
					WHERE user_id != 'system:email'
					UNION
					SELECT user_id FROM email_delivery_events
					WHERE user_id != 'system:email'
				)
			)
			AND approval.thread_count = (
				SELECT COUNT(*) FROM email_threads
				WHERE user_id != 'system:email'
			)
			AND approval.message_count = (
				SELECT COUNT(*) FROM email_messages
				WHERE user_id != 'system:email'
			)
			AND approval.attachment_count = (
				SELECT COUNT(*)
				FROM email_attachments attachment
				INNER JOIN email_messages message
					ON message.id = attachment.message_id
				WHERE message.user_id != 'system:email'
			)
			AND approval.event_count = (
				SELECT COUNT(*) FROM email_delivery_events
				WHERE user_id != 'system:email'
			)
	)
	OR (
		NOT EXISTS (SELECT 1 FROM email_user_graph_drop_approval)
		AND EXISTS (
			SELECT 1 FROM email_user_graph_authority
			WHERE singleton = 1 AND owner_count = 0
		)
		AND (SELECT COUNT(*) FROM email_threads) = 0
		AND (SELECT COUNT(*) FROM email_messages) = 0
		AND (SELECT COUNT(*) FROM email_attachments) = 0
		AND (SELECT COUNT(*) FROM email_delivery_events) = 0
	)
THEN 1 ELSE 0 END;

-- This idempotency-only table was not covered by the immutable 0134 approval
-- contract. Preserve every row and detach its obsolete graph foreign key
-- instead of treating an unsigned count as permission to drop it.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	(
		SELECT group_concat(name, ',')
		FROM (
			SELECT name
			FROM pragma_table_info('email_inbound_usage_effects')
			ORDER BY cid
		)
	) = 'user_id,delivery_id,finalization_token,created_at'
	AND (
		SELECT COUNT(*)
		FROM pragma_foreign_key_list('email_inbound_usage_effects')
		WHERE "table" = 'email_delivery_events'
			AND "from" = 'delivery_id'
			AND "to" = 'id'
			AND on_delete = 'CASCADE'
	) = 1
	AND (
		SELECT COUNT(*)
		FROM pragma_foreign_key_list('email_inbound_usage_effects')
	) = 1
THEN 1 ELSE 0 END;

-- No provider-index repair may be pending. Live/future inbound hints are valid;
-- only the one-time cutover-audit backlog must be empty.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	NOT EXISTS (SELECT 1 FROM email_outbound_provider_index_repair_owners)
	AND NOT EXISTS (
		SELECT 1 FROM email_inbound_due_owners WHERE reason = 'cutover-audit'
	)
THEN 1 ELSE 0 END;

-- Dedicated system authority and the no-provider-link disposition must remain
-- valid at the destructive boundary.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
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

-- Exact legacy/dedicated system graph parity. IS NOT is SQLite's null-safe
-- inequality; large rows are split into bounded predicate groups.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	(SELECT COUNT(*) FROM email_threads WHERE user_id = 'system:email') =
		(SELECT COUNT(*) FROM system_email_threads)
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
	AND NOT EXISTS (
		SELECT 1
		FROM email_threads legacy
		INNER JOIN system_email_threads dedicated ON dedicated.id = legacy.id
		WHERE legacy.user_id = 'system:email' AND (
			legacy.id IS NOT dedicated.id
			OR legacy.inbox_id IS NOT dedicated.inbox_id
			OR legacy.subject_normalized IS NOT dedicated.subject_normalized
			OR legacy.root_message_id_header IS NOT dedicated.root_message_id_header
			OR legacy.last_message_at IS NOT dedicated.last_message_at
			OR legacy.created_at IS NOT dedicated.created_at
			OR legacy.updated_at IS NOT dedicated.updated_at
		)
	)
THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	(SELECT COUNT(*) FROM email_messages WHERE user_id = 'system:email') =
		(SELECT COUNT(*) FROM system_email_messages)
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

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN NOT EXISTS (
	SELECT 1
	FROM email_messages legacy
	INNER JOIN system_email_messages dedicated ON dedicated.id = legacy.id
	WHERE legacy.user_id = 'system:email' AND (
		legacy.id IS NOT dedicated.id
		OR legacy.direction IS NOT dedicated.direction
		OR legacy.inbox_id IS NOT dedicated.inbox_id
		OR legacy.thread_id IS NOT dedicated.thread_id
		OR legacy.sender_identity_id IS NOT dedicated.sender_identity_id
		OR legacy.from_address IS NOT dedicated.from_address
		OR legacy.envelope_from IS NOT dedicated.envelope_from
		OR legacy.to_addresses_json IS NOT dedicated.to_addresses_json
		OR legacy.cc_addresses_json IS NOT dedicated.cc_addresses_json
		OR legacy.bcc_addresses_json IS NOT dedicated.bcc_addresses_json
		OR legacy.reply_to_addresses_json IS NOT dedicated.reply_to_addresses_json
		OR legacy.subject IS NOT dedicated.subject
	)
) THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN NOT EXISTS (
	SELECT 1
	FROM email_messages legacy
	INNER JOIN system_email_messages dedicated ON dedicated.id = legacy.id
	WHERE legacy.user_id = 'system:email' AND (
		legacy.message_id_header IS NOT dedicated.message_id_header
		OR legacy.in_reply_to_header IS NOT dedicated.in_reply_to_header
		OR legacy.references_json IS NOT dedicated.references_json
		OR legacy.headers_json IS NOT dedicated.headers_json
		OR legacy.auth_results IS NOT dedicated.auth_results
		OR legacy.text_body IS NOT dedicated.text_body
		OR legacy.html_body IS NOT dedicated.html_body
		OR legacy.raw_size IS NOT dedicated.raw_size
		OR legacy.processing_status IS NOT dedicated.processing_status
		OR legacy.provider_message_id IS NOT dedicated.provider_message_id
		OR legacy.error IS NOT dedicated.error
		OR legacy.received_at IS NOT dedicated.received_at
	)
) THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN NOT EXISTS (
	SELECT 1
	FROM email_messages legacy
	INNER JOIN system_email_messages dedicated ON dedicated.id = legacy.id
	WHERE legacy.user_id = 'system:email' AND (
		legacy.sent_at IS NOT dedicated.sent_at
		OR legacy.created_at IS NOT dedicated.created_at
		OR legacy.updated_at IS NOT dedicated.updated_at
		OR legacy.raw_mime_key IS NOT dedicated.raw_mime_key
		OR legacy.delivery_status IS NOT dedicated.delivery_status
		OR legacy.delivery_status_at IS NOT dedicated.delivery_status_at
		OR legacy.classification IS NOT dedicated.classification
		OR legacy.classification_reason IS NOT dedicated.classification_reason
	)
) THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
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
	AND NOT EXISTS (
		SELECT 1
		FROM email_attachments legacy
		INNER JOIN email_messages owner ON owner.id = legacy.message_id
		INNER JOIN system_email_attachments dedicated ON dedicated.id = legacy.id
		WHERE owner.user_id = 'system:email' AND (
			legacy.id IS NOT dedicated.id
			OR legacy.message_id IS NOT dedicated.message_id
			OR legacy.filename IS NOT dedicated.filename
			OR legacy.content_type IS NOT dedicated.content_type
			OR legacy.content_id IS NOT dedicated.content_id
			OR legacy.disposition IS NOT dedicated.disposition
			OR legacy.size IS NOT dedicated.size
			OR legacy.storage_kind IS NOT dedicated.storage_kind
			OR legacy.storage_key IS NOT dedicated.storage_key
			OR legacy.created_at IS NOT dedicated.created_at
		)
	)
THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	(SELECT COUNT(*) FROM email_delivery_events WHERE user_id = 'system:email') =
		(SELECT COUNT(*) FROM system_email_delivery_events)
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

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN NOT EXISTS (
	SELECT 1
	FROM email_delivery_events legacy
	INNER JOIN system_email_delivery_events dedicated ON dedicated.id = legacy.id
	WHERE legacy.user_id = 'system:email' AND (
		legacy.id IS NOT dedicated.id
		OR legacy.message_id IS NOT dedicated.message_id
		OR legacy.inbox_id IS NOT dedicated.inbox_id
		OR legacy.event_type IS NOT dedicated.event_type
		OR legacy.provider IS NOT dedicated.provider
		OR legacy.provider_message_id IS NOT dedicated.provider_message_id
		OR legacy.provider_event_id IS NOT dedicated.provider_event_id
		OR legacy.detail_json IS NOT dedicated.detail_json
		OR legacy.created_at IS NOT dedicated.created_at
		OR legacy.needs_effect_reconcile IS NOT dedicated.needs_effect_reconcile
		OR legacy.usage_effect_recorded_at IS NOT dedicated.usage_effect_recorded_at
		OR legacy.usage_month IS NOT dedicated.usage_month
		OR legacy.usage_bytes IS NOT dedicated.usage_bytes
		OR legacy.usage_duration_ms IS NOT dedicated.usage_duration_ms
	)
) THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN NOT EXISTS (
	SELECT 1
	FROM email_delivery_events legacy
	INNER JOIN system_email_delivery_events dedicated ON dedicated.id = legacy.id
	WHERE legacy.user_id = 'system:email' AND (
		legacy.state IS NOT dedicated.state
		OR legacy.fingerprint IS NOT dedicated.fingerprint
		OR legacy.storage_lease IS NOT dedicated.storage_lease
		OR legacy.storage_lease_at IS NOT dedicated.storage_lease_at
		OR legacy.cleanup_lease IS NOT dedicated.cleanup_lease
		OR legacy.cleanup_lease_at IS NOT dedicated.cleanup_lease_at
		OR legacy.cleanup_retry_at IS NOT dedicated.cleanup_retry_at
		OR legacy.expected_attachment_count IS NOT dedicated.expected_attachment_count
		OR legacy.finalization_token IS NOT dedicated.finalization_token
		OR legacy.reconcile_after IS NOT dedicated.reconcile_after
		OR legacy.dedupe_expires_at IS NOT dedicated.dedupe_expires_at
		OR legacy.usage_effect_suppressed_at IS NOT
			dedicated.usage_effect_suppressed_at
		OR legacy.usage_started_at IS NOT dedicated.usage_started_at
		OR legacy.usage_effect_retry_at IS NOT dedicated.usage_effect_retry_at
	)
) THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN NOT EXISTS (
	SELECT 1
	FROM email_delivery_events legacy
	INNER JOIN system_email_delivery_events dedicated ON dedicated.id = legacy.id
	WHERE legacy.user_id = 'system:email' AND (
		legacy.usage_effect_lease IS NOT dedicated.usage_effect_lease
		OR legacy.usage_effect_lease_at IS NOT dedicated.usage_effect_lease_at
		OR legacy.subscription_effect_state IS NOT
			dedicated.subscription_effect_state
		OR legacy.subscription_effect_lease IS NOT
			dedicated.subscription_effect_lease
		OR legacy.subscription_effect_lease_at IS NOT
			dedicated.subscription_effect_lease_at
		OR legacy.subscription_effect_retry_at IS NOT
			dedicated.subscription_effect_retry_at
		OR legacy.subscription_effect_attempt_count IS NOT
			dedicated.subscription_effect_attempt_count
		OR legacy.subscription_effect_dead_letter_at IS NOT
			dedicated.subscription_effect_dead_letter_at
		OR legacy.subscription_effect_last_error IS NOT
			dedicated.subscription_effect_last_error
		OR legacy.updated_at IS NOT dedicated.updated_at
	)
) THEN 1 ELSE 0 END;

-- No unexpected schema object may retain a live dependency on the graph.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM sqlite_schema
WHERE type = 'trigger'
	AND name = 'email_messages_delete_outbound_provider_index'
	AND tbl_name = 'email_messages'
	AND instr(lower(sql), 'after delete on email_messages') > 0
	AND instr(lower(sql), 'delete from email_outbound_provider_index') > 0;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
WITH schema_objects AS (
	SELECT
		type,
		name,
		tbl_name,
		' ' || replace(
			replace(
				replace(
					replace(
						replace(
							replace(
								replace(lower(sql), char(10), ' '),
								char(9),
								' '
							),
							'"',
							' '
						),
						'[',
						' '
					),
					']',
					' '
				),
				'(',
				' '
			),
			')',
			' '
		) || ' ' AS normalized_sql
	FROM sqlite_schema
	WHERE type IN ('view', 'trigger')
)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM schema_objects
WHERE NOT (
		type = 'trigger'
		AND name = 'email_messages_delete_outbound_provider_index'
		AND tbl_name = 'email_messages'
	)
	AND (
		instr(normalized_sql, ' email_threads ') > 0
		OR instr(normalized_sql, ' email_messages ') > 0
		OR instr(normalized_sql, ' email_attachments ') > 0
		OR instr(normalized_sql, ' email_delivery_events ') > 0
	);

CREATE TABLE migration_0135_surviving_foreign_keys (
	source_table TEXT NOT NULL,
	referenced_table TEXT NOT NULL
);

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'email_inbox_addresses', "table" FROM pragma_foreign_key_list('email_inbox_addresses');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'email_verifications', "table" FROM pragma_foreign_key_list('email_verifications');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'feature_flag_user_overrides', "table" FROM pragma_foreign_key_list('feature_flag_user_overrides');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'feature_flags', "table" FROM pragma_foreign_key_list('feature_flags');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'invites', "table" FROM pragma_foreign_key_list('invites');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'mcp_memory_conversation_suppressions', "table" FROM pragma_foreign_key_list('mcp_memory_conversation_suppressions');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'oauth_connections', "table" FROM pragma_foreign_key_list('oauth_connections');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'passkeys', "table" FROM pragma_foreign_key_list('passkeys');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'password_resets', "table" FROM pragma_foreign_key_list('password_resets');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'pending_email_changes', "table" FROM pragma_foreign_key_list('pending_email_changes');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'role_permissions', "table" FROM pragma_foreign_key_list('role_permissions');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'secret_entries', "table" FROM pragma_foreign_key_list('secret_entries');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'system_email_attachments', "table" FROM pragma_foreign_key_list('system_email_attachments');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'system_email_delivery_events', "table" FROM pragma_foreign_key_list('system_email_delivery_events');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'system_email_messages', "table" FROM pragma_foreign_key_list('system_email_messages');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'system_email_threads', "table" FROM pragma_foreign_key_list('system_email_threads');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'user_integrations', "table" FROM pragma_foreign_key_list('user_integrations');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'user_openapi_binding_operations', "table" FROM pragma_foreign_key_list('user_openapi_binding_operations');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'user_roles', "table" FROM pragma_foreign_key_list('user_roles');

INSERT INTO migration_0135_surviving_foreign_keys (source_table, referenced_table)
SELECT 'value_entries', "table" FROM pragma_foreign_key_list('value_entries');

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM migration_0135_surviving_foreign_keys
WHERE referenced_table IN (
	'email_threads',
	'email_messages',
	'email_attachments',
	'email_delivery_events'
)
	OR (
		referenced_table = 'users'
		AND source_table NOT IN (
			'email_verifications',
			'feature_flag_user_overrides',
			'feature_flags',
			'invites',
			'oauth_connections',
			'passkeys',
			'password_resets',
			'pending_email_changes',
			'user_roles'
		)
	);

DROP TABLE migration_0135_surviving_foreign_keys;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM pragma_foreign_key_check;

-- Fail closed if any reviewed users child foreign key changed. Rebuilding the
-- parent is safe only after every exact child relation is snapshotted and cleared.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM pragma_foreign_key_list('email_verifications')
WHERE "table" = 'users'
	AND "from" = 'user_id'
	AND "to" = 'id'
	AND on_delete = 'CASCADE';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM pragma_foreign_key_list('feature_flags')
WHERE "table" = 'users'
	AND "from" = 'updated_by'
	AND "to" = 'id'
	AND on_delete = 'SET NULL';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM pragma_foreign_key_list('invites')
WHERE "table" = 'users'
	AND "from" = 'created_by'
	AND "to" = 'id'
	AND on_delete = 'SET NULL';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM pragma_foreign_key_list('oauth_connections')
WHERE "table" = 'users'
	AND "from" = 'user_id'
	AND "to" = 'id'
	AND on_delete = 'CASCADE';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM pragma_foreign_key_list('passkeys')
WHERE "table" = 'users'
	AND "from" = 'user_id'
	AND "to" = 'id'
	AND on_delete = 'CASCADE';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM pragma_foreign_key_list('password_resets')
WHERE "table" = 'users'
	AND "from" = 'user_id'
	AND "to" = 'id'
	AND on_delete = 'CASCADE';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM pragma_foreign_key_list('pending_email_changes')
WHERE "table" = 'users'
	AND "from" = 'user_id'
	AND "to" = 'id'
	AND on_delete = 'CASCADE';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM pragma_foreign_key_list('user_roles')
WHERE "table" = 'users'
	AND "from" = 'user_id'
	AND "to" = 'id'
	AND on_delete = 'CASCADE';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 2 THEN 1 ELSE 0 END
FROM pragma_foreign_key_list('feature_flag_user_overrides')
WHERE "table" = 'users'
	AND "to" = 'id'
	AND (
		("from" = 'user_id' AND on_delete = 'CASCADE')
		OR ("from" = 'updated_by' AND on_delete = 'SET NULL')
	);

-- Preserve the stable authority marker without duplicating or renaming any
-- canonical approval field. The exact 0134 receipt remains in its own table.
CREATE TABLE email_user_graph_authority_next (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	owner_count INTEGER NOT NULL CHECK (owner_count >= 0),
	frozen_at TEXT NOT NULL,
	dropped_at TEXT NOT NULL
);

INSERT INTO email_user_graph_authority_next (
	singleton, owner_count, frozen_at, dropped_at
)
SELECT
	authority.singleton,
	authority.owner_count,
	authority.frozen_at,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM email_user_graph_authority authority;

-- Detach, but do not delete, the unapproved cross-store idempotency ledger.
CREATE TABLE email_inbound_usage_effects_next (
	user_id TEXT NOT NULL,
	delivery_id TEXT NOT NULL,
	finalization_token TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (user_id, delivery_id, finalization_token)
);

INSERT INTO email_inbound_usage_effects_next (
	user_id, delivery_id, finalization_token, created_at
)
SELECT user_id, delivery_id, finalization_token, created_at
FROM email_inbound_usage_effects;

DROP TABLE email_inbound_usage_effects;
ALTER TABLE email_inbound_usage_effects_next
	RENAME TO email_inbound_usage_effects;
CREATE INDEX idx_email_inbound_usage_effects_delivery
	ON email_inbound_usage_effects(delivery_id);

-- Rebuild users once. Cloudflare D1 keeps foreign keys enabled around each
-- migration, so snapshot and clear the nine direct child tables before
-- dropping the parent. This preserves child schemas and avoids 14 table
-- rewrites from sequential DROP COLUMN statements.
CREATE TABLE _mig0135_password_resets AS SELECT * FROM password_resets;
CREATE TABLE _mig0135_email_verifications AS SELECT * FROM email_verifications;
CREATE TABLE _mig0135_pending_email_changes AS SELECT * FROM pending_email_changes;
CREATE TABLE _mig0135_passkeys AS SELECT * FROM passkeys;
CREATE TABLE _mig0135_oauth_connections AS SELECT * FROM oauth_connections;
CREATE TABLE _mig0135_user_roles AS SELECT * FROM user_roles;
CREATE TABLE _mig0135_invites AS SELECT * FROM invites;
CREATE TABLE _mig0135_feature_flags AS SELECT * FROM feature_flags;
CREATE TABLE _mig0135_feature_flag_user_overrides AS
SELECT * FROM feature_flag_user_overrides;
CREATE TABLE _mig0135_users_meta AS
SELECT
	(SELECT COUNT(*) FROM users) AS row_count,
	(SELECT seq FROM sqlite_sequence WHERE name = 'users') AS sequence;

CREATE TABLE users_next (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	username TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	email_verified_at TEXT,
	plan TEXT NOT NULL DEFAULT 'free' CHECK (
		plan IN ('free', 'partner', 'pro', 'max')
	),
	stable_user_id TEXT NOT NULL,
	stripe_customer_id TEXT,
	stripe_plan TEXT,
	stripe_plan_refreshed_at TEXT,
	display_name TEXT,
	bio TEXT,
	profile_visibility TEXT NOT NULL DEFAULT 'public' CHECK (
		profile_visibility IN ('public', 'private')
	),
	avatar_key TEXT,
	account_type TEXT NOT NULL DEFAULT 'person' CHECK (
		account_type IN ('person', 'platform')
	),
	deleting_at TEXT,
	active_write_count INTEGER NOT NULL DEFAULT 0,
	active_write_expires_at TEXT,
	suspended_at TEXT,
	email_outbound_paused_at TEXT,
	password_changed_at TEXT,
	job_retention_success_once_days INTEGER CHECK (
		job_retention_success_once_days IS NULL
		OR (
			job_retention_success_once_days >= 1
			AND job_retention_success_once_days <= 365
		)
	),
	job_retention_failed_once_days INTEGER CHECK (
		job_retention_failed_once_days IS NULL
		OR (
			job_retention_failed_once_days >= 1
			AND job_retention_failed_once_days <= 365
		)
	),
	job_retention_disabled_recurring_days INTEGER CHECK (
		job_retention_disabled_recurring_days IS NULL
		OR (
			job_retention_disabled_recurring_days >= 1
			AND job_retention_disabled_recurring_days <= 365
		)
	),
	d1_storage_bytes INTEGER NOT NULL DEFAULT 0,
	d1_storage_bytes_updated_at TEXT
);

INSERT INTO users_next (
	id, username, email, password_hash, created_at, updated_at,
	email_verified_at, plan, stable_user_id, stripe_customer_id, stripe_plan,
	stripe_plan_refreshed_at, display_name, bio, profile_visibility, avatar_key,
	account_type, deleting_at, active_write_count, active_write_expires_at,
	suspended_at, email_outbound_paused_at, password_changed_at,
	job_retention_success_once_days, job_retention_failed_once_days,
	job_retention_disabled_recurring_days, d1_storage_bytes,
	d1_storage_bytes_updated_at
)
SELECT
	id, username, email, password_hash, created_at, updated_at,
	email_verified_at, plan, stable_user_id, stripe_customer_id, stripe_plan,
	stripe_plan_refreshed_at, display_name, bio, profile_visibility, avatar_key,
	account_type, deleting_at, active_write_count, active_write_expires_at,
	suspended_at, email_outbound_paused_at, password_changed_at,
	job_retention_success_once_days, job_retention_failed_once_days,
	job_retention_disabled_recurring_days, d1_storage_bytes,
	d1_storage_bytes_updated_at
FROM users;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	(SELECT row_count FROM _mig0135_users_meta) =
		(SELECT COUNT(*) FROM users_next)
	AND NOT EXISTS (
		SELECT
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, plan, stable_user_id, stripe_customer_id,
			stripe_plan, stripe_plan_refreshed_at, display_name, bio,
			profile_visibility, avatar_key, account_type, deleting_at,
			active_write_count, active_write_expires_at, suspended_at,
			email_outbound_paused_at, password_changed_at,
			job_retention_success_once_days, job_retention_failed_once_days,
			job_retention_disabled_recurring_days, d1_storage_bytes,
			d1_storage_bytes_updated_at
		FROM users
		EXCEPT
		SELECT
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, plan, stable_user_id, stripe_customer_id,
			stripe_plan, stripe_plan_refreshed_at, display_name, bio,
			profile_visibility, avatar_key, account_type, deleting_at,
			active_write_count, active_write_expires_at, suspended_at,
			email_outbound_paused_at, password_changed_at,
			job_retention_success_once_days, job_retention_failed_once_days,
			job_retention_disabled_recurring_days, d1_storage_bytes,
			d1_storage_bytes_updated_at
		FROM users_next
	)
THEN 1 ELSE 0 END;

DELETE FROM feature_flag_user_overrides;
DELETE FROM feature_flags;
DELETE FROM invites;
DELETE FROM user_roles;
DELETE FROM oauth_connections;
DELETE FROM passkeys;
DELETE FROM pending_email_changes;
DELETE FROM email_verifications;
DELETE FROM password_resets;

DROP TABLE users;
ALTER TABLE users_next RENAME TO users;

-- Never lower AUTOINCREMENT: preserve deleted allocations as well as live ids.
UPDATE sqlite_sequence
SET seq = (
	SELECT MAX(value) FROM (
		SELECT seq AS value FROM sqlite_sequence WHERE name = 'users'
		UNION ALL
		SELECT sequence AS value FROM _mig0135_users_meta
	)
)
WHERE name = 'users'
	AND EXISTS (
		SELECT 1 FROM _mig0135_users_meta WHERE sequence IS NOT NULL
	);

INSERT INTO sqlite_sequence (name, seq)
SELECT 'users', sequence FROM _mig0135_users_meta
WHERE sequence IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'users');

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE UNIQUE INDEX idx_users_stable_user_id ON users(stable_user_id);
CREATE UNIQUE INDEX idx_users_stripe_customer_id
	ON users(stripe_customer_id)
	WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX idx_users_deleting_at
	ON users(deleting_at)
	WHERE deleting_at IS NOT NULL;
CREATE INDEX idx_users_d1_storage_bytes_reconciliation
	ON users(d1_storage_bytes_updated_at, stable_user_id);

INSERT INTO password_resets SELECT * FROM _mig0135_password_resets;
INSERT INTO email_verifications SELECT * FROM _mig0135_email_verifications;
INSERT INTO pending_email_changes SELECT * FROM _mig0135_pending_email_changes;
INSERT INTO passkeys SELECT * FROM _mig0135_passkeys;
INSERT INTO oauth_connections SELECT * FROM _mig0135_oauth_connections;
INSERT INTO user_roles SELECT * FROM _mig0135_user_roles;
INSERT INTO invites SELECT * FROM _mig0135_invites;
INSERT INTO feature_flags SELECT * FROM _mig0135_feature_flags;
INSERT INTO feature_flag_user_overrides
SELECT * FROM _mig0135_feature_flag_user_overrides;

DROP TABLE _mig0135_password_resets;
DROP TABLE _mig0135_email_verifications;
DROP TABLE _mig0135_pending_email_changes;
DROP TABLE _mig0135_passkeys;
DROP TABLE _mig0135_oauth_connections;
DROP TABLE _mig0135_user_roles;
DROP TABLE _mig0135_invites;
DROP TABLE _mig0135_feature_flags;
DROP TABLE _mig0135_feature_flag_user_overrides;
DROP TABLE _mig0135_users_meta;

DROP TRIGGER email_messages_delete_outbound_provider_index;
DROP TABLE email_attachments;
DROP TABLE email_delivery_events;
DROP TABLE email_messages;
DROP TABLE email_threads;

DROP TABLE email_user_graph_authority;
ALTER TABLE email_user_graph_authority_next
	RENAME TO email_user_graph_authority;

-- All copied data and surviving foreign keys must still be valid before the
-- transaction is allowed to commit.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM pragma_foreign_key_check;

DROP TABLE migration_0135_legacy_email_graph_drop_guard;
