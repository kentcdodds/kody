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
			AND approval.source_account_id =
				'a99ee2e72728dd52902ef288b7b1447d'
			AND approval.source_database_id =
				'8c1014d1-6b41-4695-a0a2-159071f0f919'
			AND approval.source_database_name = 'kody'
			AND approval.manifest_key_id = 'kody-dr-2026-07'
			AND approval.signature_algorithm = 'Ed25519'
			AND approval.retention_tier = 'daily'
			AND approval.restore_baseline_id = 'kody-migration-set-2026-07'
			AND approval.restore_baseline_sha256 =
				'feb76eb26ed72a55d5fa25d14ef9ee904d0758fc29842c898b584a921ccfd995'
			AND approval.build_commit =
				'fe1ca2772de7f369fc06a7d1bd9aeadc3347b2a7'
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

-- D1 rejects non-literal pragma_foreign_key_list arguments with SQLITE_AUTH.
-- Make the exhaustive static pragma scan complete by first rejecting every
-- unknown or missing schema table; the optional d1_migrations table exists only
-- when Wrangler, rather than the node:sqlite harness, applies this chain.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN group_concat(name, ',') IN (
	'account_write_lease_repairs,account_write_leases,agent_package_conversation_uses,archived_job_artifacts,community_activity_events,community_bans,community_forks,community_listings,community_ratings,community_reports,community_stars,email_attachments,email_delivery_alert_events,email_delivery_events,email_inbound_due_owners,email_inbound_usage_effects,email_inbox_addresses,email_inboxes,email_messages,email_outbound_provider_index,email_outbound_provider_index_repair_owners,email_sender_identities,email_sender_rules,email_threads,email_user_graph_authority,email_user_graph_drop_approval,email_verifications,entity_sources,feature_flag_exposure_rollups,feature_flag_user_overrides,feature_flags,invites,jobs,mcp_agent_sessions,mcp_memories,mcp_memory_conversation_suppressions,mcp_server_settings,mcp_user_server_instructions,migration_0135_legacy_email_graph_drop_guard,oauth_connections,package_codemod_run_items,package_codemod_runs,package_invocation_tokens,package_scope_grants,package_service_states,passkeys,password_resets,pending_email_changes,permissions,platform_feedback,published_bundle_artifacts,remote_connector_settings,repo_sessions,role_permissions,roles,saved_packages,secret_buckets,secret_entries,stripe_webhook_events,system_email_attachments,system_email_daily_counters,system_email_delivery_events,system_email_graph_authority,system_email_messages,system_email_threads,usage_rollups,user_activation_milestones,user_follows,user_integrations,user_oauth_apps,user_openapi_binding_operations,user_openapi_bindings,user_package_run_successes,user_roles,user_storage_buckets,users,value_buckets,value_entries,verifications,webhook_endpoints,workflow_runs',
	'account_write_lease_repairs,account_write_leases,agent_package_conversation_uses,archived_job_artifacts,community_activity_events,community_bans,community_forks,community_listings,community_ratings,community_reports,community_stars,d1_migrations,email_attachments,email_delivery_alert_events,email_delivery_events,email_inbound_due_owners,email_inbound_usage_effects,email_inbox_addresses,email_inboxes,email_messages,email_outbound_provider_index,email_outbound_provider_index_repair_owners,email_sender_identities,email_sender_rules,email_threads,email_user_graph_authority,email_user_graph_drop_approval,email_verifications,entity_sources,feature_flag_exposure_rollups,feature_flag_user_overrides,feature_flags,invites,jobs,mcp_agent_sessions,mcp_memories,mcp_memory_conversation_suppressions,mcp_server_settings,mcp_user_server_instructions,migration_0135_legacy_email_graph_drop_guard,oauth_connections,package_codemod_run_items,package_codemod_runs,package_invocation_tokens,package_scope_grants,package_service_states,passkeys,password_resets,pending_email_changes,permissions,platform_feedback,published_bundle_artifacts,remote_connector_settings,repo_sessions,role_permissions,roles,saved_packages,secret_buckets,secret_entries,stripe_webhook_events,system_email_attachments,system_email_daily_counters,system_email_delivery_events,system_email_graph_authority,system_email_messages,system_email_threads,usage_rollups,user_activation_milestones,user_follows,user_integrations,user_oauth_apps,user_openapi_binding_operations,user_openapi_bindings,user_package_run_successes,user_roles,user_storage_buckets,users,value_buckets,value_entries,verifications,webhook_endpoints,workflow_runs'
) THEN 1 ELSE 0 END
FROM (
	SELECT name FROM sqlite_schema
	WHERE type = 'table'
		AND name NOT LIKE 'sqlite_%'
		AND name NOT LIKE '\_cf\_%' ESCAPE '\'
	ORDER BY name
);

-- Preserve semantic DDL details that table_xinfo does not expose. Removing
-- whitespace, identifier quotes, and keyword case avoids formatting-only drift
-- while retaining CHECK, COLLATE, and generated-column expressions.
CREATE TABLE migration_0135_expected_users_table_sql (
	phase TEXT PRIMARY KEY NOT NULL,
	normalized_sql TEXT NOT NULL
);

INSERT INTO migration_0135_expected_users_table_sql (phase, normalized_sql) VALUES
	('pre', 'createtableusers(idintegerprimarykeyautoincrementnotnull,usernametextnotnullunique,emailtextnotnullunique,password_hashtextnotnull,created_attextnotnulldefault(current_timestamp),updated_attextnotnulldefault(current_timestamp),email_verified_attext,plantextnotnulldefault''free''check(planin(''free'',''partner'',''pro'',''max'')),stable_user_idtextnotnull,stripe_customer_idtext,stripe_plantext,stripe_plan_refreshed_attext,display_nametext,biotext,profile_visibilitytextnotnulldefault''public''check(profile_visibilityin(''public'',''private'')),avatar_keytext,account_typetextnotnulldefault''person''check(account_typein(''person'',''platform'')),deleting_attext,active_write_countintegernotnulldefault0,active_write_expires_attext,suspended_attext,email_outbound_paused_attext,password_changed_attext,job_retention_success_once_daysintegercheck(job_retention_success_once_daysisnullor(job_retention_success_once_days>=1andjob_retention_success_once_days<=365)),job_retention_failed_once_daysintegercheck(job_retention_failed_once_daysisnullor(job_retention_failed_once_days>=1andjob_retention_failed_once_days<=365)),job_retention_disabled_recurring_daysintegercheck(job_retention_disabled_recurring_daysisnullor(job_retention_disabled_recurring_days>=1andjob_retention_disabled_recurring_days<=365)),d1_storage_bytesintegernotnulldefault0,d1_storage_bytes_updated_attext,mailbox_parity_checked_attext,mailbox_parity_matching_sincetext,mailbox_parity_mismatch_countintegernotnulldefault0check(mailbox_parity_mismatch_count>=0),mailbox_parity_last_errortext,mailbox_parity_content_watermark_attext,mailbox_parity_content_replay_upper_attext,mailbox_parity_content_replay_cursor_updated_attext,mailbox_parity_content_replay_cursor_idtext,mailbox_parity_message_backfill_cursor_created_attext,mailbox_parity_message_backfill_cursor_idtext,mailbox_parity_message_backfill_completed_attext,mailbox_parity_event_backfill_cursor_created_attext,mailbox_parity_event_backfill_cursor_idtext,mailbox_parity_event_backfill_completed_attext)'),
	('post', 'createtableusers(idintegerprimarykeyautoincrementnotnull,usernametextnotnullunique,emailtextnotnullunique,password_hashtextnotnull,created_attextnotnulldefault(current_timestamp),updated_attextnotnulldefault(current_timestamp),email_verified_attext,plantextnotnulldefault''free''check(planin(''free'',''partner'',''pro'',''max'')),stable_user_idtextnotnull,stripe_customer_idtext,stripe_plantext,stripe_plan_refreshed_attext,display_nametext,biotext,profile_visibilitytextnotnulldefault''public''check(profile_visibilityin(''public'',''private'')),avatar_keytext,account_typetextnotnulldefault''person''check(account_typein(''person'',''platform'')),deleting_attext,active_write_countintegernotnulldefault0,active_write_expires_attext,suspended_attext,email_outbound_paused_attext,password_changed_attext,job_retention_success_once_daysintegercheck(job_retention_success_once_daysisnullor(job_retention_success_once_days>=1andjob_retention_success_once_days<=365)),job_retention_failed_once_daysintegercheck(job_retention_failed_once_daysisnullor(job_retention_failed_once_days>=1andjob_retention_failed_once_days<=365)),job_retention_disabled_recurring_daysintegercheck(job_retention_disabled_recurring_daysisnullor(job_retention_disabled_recurring_days>=1andjob_retention_disabled_recurring_days<=365)),d1_storage_bytesintegernotnulldefault0,d1_storage_bytes_updated_attext)');

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM sqlite_schema schema_object
INNER JOIN migration_0135_expected_users_table_sql expected
	ON expected.phase = 'pre'
	AND expected.normalized_sql = lower(
			replace(
				replace(
					replace(
						replace(
							replace(
								replace(
									replace(
										replace(schema_object.sql, ' ', ''),
										char(9),
										''
									),
									char(10),
									''
								),
								char(13),
								''
							),
							'"',
							''
						),
						char(96),
						''
					),
					'[',
					''
				),
				']',
				''
			)
		)
WHERE schema_object.type = 'table'
	AND schema_object.name = 'users';

-- Exact reviewed users contract through 0134. cid makes the table-xinfo check
-- ordered as well as complete; any future, missing, reordered, or changed column
-- aborts before the first destructive statement.
CREATE TABLE migration_0135_expected_users_columns (
	cid INTEGER NOT NULL,
	name TEXT NOT NULL,
	type TEXT NOT NULL,
	not_null INTEGER NOT NULL,
	default_value TEXT,
	pk INTEGER NOT NULL,
	hidden INTEGER NOT NULL
);

INSERT INTO migration_0135_expected_users_columns (cid, name, type, not_null, default_value, pk, hidden) VALUES
	(0, 'id', 'INTEGER', 1, NULL, 1, 0),
	(1, 'username', 'TEXT', 1, NULL, 0, 0),
	(2, 'email', 'TEXT', 1, NULL, 0, 0),
	(3, 'password_hash', 'TEXT', 1, NULL, 0, 0),
	(4, 'created_at', 'TEXT', 1, 'CURRENT_TIMESTAMP', 0, 0),
	(5, 'updated_at', 'TEXT', 1, 'CURRENT_TIMESTAMP', 0, 0),
	(6, 'email_verified_at', 'TEXT', 0, NULL, 0, 0),
	(7, 'plan', 'TEXT', 1, '''free''', 0, 0),
	(8, 'stable_user_id', 'TEXT', 1, NULL, 0, 0),
	(9, 'stripe_customer_id', 'TEXT', 0, NULL, 0, 0);

INSERT INTO migration_0135_expected_users_columns (cid, name, type, not_null, default_value, pk, hidden) VALUES
	(10, 'stripe_plan', 'TEXT', 0, NULL, 0, 0),
	(11, 'stripe_plan_refreshed_at', 'TEXT', 0, NULL, 0, 0),
	(12, 'display_name', 'TEXT', 0, NULL, 0, 0),
	(13, 'bio', 'TEXT', 0, NULL, 0, 0),
	(14, 'profile_visibility', 'TEXT', 1, '''public''', 0, 0),
	(15, 'avatar_key', 'TEXT', 0, NULL, 0, 0),
	(16, 'account_type', 'TEXT', 1, '''person''', 0, 0),
	(17, 'deleting_at', 'TEXT', 0, NULL, 0, 0),
	(18, 'active_write_count', 'INTEGER', 1, '0', 0, 0),
	(19, 'active_write_expires_at', 'TEXT', 0, NULL, 0, 0);

INSERT INTO migration_0135_expected_users_columns (cid, name, type, not_null, default_value, pk, hidden) VALUES
	(20, 'suspended_at', 'TEXT', 0, NULL, 0, 0),
	(21, 'email_outbound_paused_at', 'TEXT', 0, NULL, 0, 0),
	(22, 'password_changed_at', 'TEXT', 0, NULL, 0, 0),
	(23, 'job_retention_success_once_days', 'INTEGER', 0, NULL, 0, 0),
	(24, 'job_retention_failed_once_days', 'INTEGER', 0, NULL, 0, 0),
	(25, 'job_retention_disabled_recurring_days', 'INTEGER', 0, NULL, 0, 0),
	(26, 'd1_storage_bytes', 'INTEGER', 1, '0', 0, 0),
	(27, 'd1_storage_bytes_updated_at', 'TEXT', 0, NULL, 0, 0),
	(28, 'mailbox_parity_checked_at', 'TEXT', 0, NULL, 0, 0),
	(29, 'mailbox_parity_matching_since', 'TEXT', 0, NULL, 0, 0);

INSERT INTO migration_0135_expected_users_columns (cid, name, type, not_null, default_value, pk, hidden) VALUES
	(30, 'mailbox_parity_mismatch_count', 'INTEGER', 1, '0', 0, 0),
	(31, 'mailbox_parity_last_error', 'TEXT', 0, NULL, 0, 0),
	(32, 'mailbox_parity_content_watermark_at', 'TEXT', 0, NULL, 0, 0),
	(33, 'mailbox_parity_content_replay_upper_at', 'TEXT', 0, NULL, 0, 0),
	(34, 'mailbox_parity_content_replay_cursor_updated_at', 'TEXT', 0, NULL, 0, 0),
	(35, 'mailbox_parity_content_replay_cursor_id', 'TEXT', 0, NULL, 0, 0),
	(36, 'mailbox_parity_message_backfill_cursor_created_at', 'TEXT', 0, NULL, 0, 0),
	(37, 'mailbox_parity_message_backfill_cursor_id', 'TEXT', 0, NULL, 0, 0),
	(38, 'mailbox_parity_message_backfill_completed_at', 'TEXT', 0, NULL, 0, 0),
	(39, 'mailbox_parity_event_backfill_cursor_created_at', 'TEXT', 0, NULL, 0, 0);

INSERT INTO migration_0135_expected_users_columns (cid, name, type, not_null, default_value, pk, hidden) VALUES
	(40, 'mailbox_parity_event_backfill_cursor_id', 'TEXT', 0, NULL, 0, 0),
	(41, 'mailbox_parity_event_backfill_completed_at', 'TEXT', 0, NULL, 0, 0);

CREATE TABLE migration_0135_expected_users_indexes (
	name TEXT NOT NULL,
	is_unique INTEGER NOT NULL,
	origin TEXT NOT NULL,
	partial INTEGER NOT NULL,
	sql TEXT
);

INSERT INTO migration_0135_expected_users_indexes (name, is_unique, origin, partial, sql) VALUES
	('idx_users_d1_storage_bytes_reconciliation', 0, 'c', 0, 'CREATE INDEX idx_users_d1_storage_bytes_reconciliation
	ON users(d1_storage_bytes_updated_at, stable_user_id)'),
	('idx_users_deleting_at', 0, 'c', 1, 'CREATE INDEX idx_users_deleting_at
	ON users(deleting_at)
	WHERE deleting_at IS NOT NULL'),
	('idx_users_email', 0, 'c', 0, 'CREATE INDEX idx_users_email ON users(email)'),
	('idx_users_mailbox_parity_checked', 0, 'c', 0, 'CREATE INDEX idx_users_mailbox_parity_checked
	ON users(mailbox_parity_checked_at, stable_user_id)'),
	('idx_users_stable_user_id', 1, 'c', 0, 'CREATE UNIQUE INDEX idx_users_stable_user_id
	ON users(stable_user_id)'),
	('idx_users_stripe_customer_id', 1, 'c', 1, 'CREATE UNIQUE INDEX idx_users_stripe_customer_id
	ON users(stripe_customer_id)
	WHERE stripe_customer_id IS NOT NULL'),
	('idx_users_username', 0, 'c', 0, 'CREATE INDEX idx_users_username ON users(username)'),
	('sqlite_autoindex_users_1', 1, 'u', 0, NULL),
	('sqlite_autoindex_users_2', 1, 'u', 0, NULL);

CREATE TABLE migration_0135_expected_users_foreign_keys (
	child_table TEXT NOT NULL,
	from_column TEXT NOT NULL,
	to_column TEXT NOT NULL,
	on_update TEXT NOT NULL,
	on_delete TEXT NOT NULL,
	match TEXT NOT NULL
);

INSERT INTO migration_0135_expected_users_foreign_keys (child_table, from_column, to_column, on_update, on_delete, match) VALUES
	('email_verifications', 'user_id', 'id', 'NO ACTION', 'CASCADE', 'NONE'),
	('feature_flag_user_overrides', 'updated_by', 'id', 'NO ACTION', 'SET NULL', 'NONE'),
	('feature_flag_user_overrides', 'user_id', 'id', 'NO ACTION', 'CASCADE', 'NONE'),
	('feature_flags', 'updated_by', 'id', 'NO ACTION', 'SET NULL', 'NONE'),
	('invites', 'created_by', 'id', 'NO ACTION', 'SET NULL', 'NONE'),
	('oauth_connections', 'user_id', 'id', 'NO ACTION', 'CASCADE', 'NONE'),
	('passkeys', 'user_id', 'id', 'NO ACTION', 'CASCADE', 'NONE'),
	('password_resets', 'user_id', 'id', 'NO ACTION', 'CASCADE', 'NONE'),
	('pending_email_changes', 'user_id', 'id', 'NO ACTION', 'CASCADE', 'NONE'),
	('user_roles', 'user_id', 'id', 'NO ACTION', 'CASCADE', 'NONE');

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	NOT EXISTS (
		SELECT cid, name, type, "notnull", dflt_value, pk, hidden
		FROM pragma_table_xinfo('users')
		EXCEPT
		SELECT cid, name, type, not_null, default_value, pk, hidden
		FROM migration_0135_expected_users_columns
	)
	AND NOT EXISTS (
		SELECT cid, name, type, not_null, default_value, pk, hidden
		FROM migration_0135_expected_users_columns
		EXCEPT
		SELECT cid, name, type, "notnull", dflt_value, pk, hidden
		FROM pragma_table_xinfo('users')
	)
THEN 1 ELSE 0 END;

CREATE TABLE migration_0135_actual_users_indexes (
	name TEXT NOT NULL,
	is_unique INTEGER NOT NULL,
	origin TEXT NOT NULL,
	partial INTEGER NOT NULL,
	sql TEXT
);

INSERT INTO migration_0135_actual_users_indexes (
	name, is_unique, origin, partial, sql
)
SELECT
	index_list.name, index_list."unique", index_list.origin,
	index_list.partial, schema_object.sql
FROM pragma_index_list('users') index_list
LEFT JOIN sqlite_schema schema_object
	ON schema_object.type = 'index'
	AND schema_object.name = index_list.name;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	NOT EXISTS (
		SELECT name, is_unique, origin, partial, sql
		FROM migration_0135_actual_users_indexes
		EXCEPT
		SELECT name, is_unique, origin, partial, sql
		FROM migration_0135_expected_users_indexes
	)
	AND NOT EXISTS (
		SELECT name, is_unique, origin, partial, sql
		FROM migration_0135_expected_users_indexes
		EXCEPT
		SELECT name, is_unique, origin, partial, sql
		FROM migration_0135_actual_users_indexes
	)
THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM sqlite_schema
WHERE type = 'trigger' AND tbl_name = 'users';

-- Exhaustively inspect every reviewed table with a literal pragma call. The
-- exact table-name guard above makes this complete: an unknown child cannot
-- escape the inventory by being absent from this list.
CREATE TABLE migration_0135_actual_users_foreign_keys (
	child_table TEXT NOT NULL,
	from_column TEXT NOT NULL,
	to_column TEXT NOT NULL,
	on_update TEXT NOT NULL,
	on_delete TEXT NOT NULL,
	match TEXT NOT NULL
);

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'account_write_lease_repairs', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('account_write_lease_repairs')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'account_write_leases', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('account_write_leases')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'agent_package_conversation_uses', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('agent_package_conversation_uses')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'archived_job_artifacts', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('archived_job_artifacts')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_activity_events', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_activity_events')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_bans', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_bans')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_forks', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_forks')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_listings', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_listings')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_ratings', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_ratings')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_reports', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_reports')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_stars', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_stars')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_attachments', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_attachments')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_delivery_alert_events', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_delivery_alert_events')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_delivery_events', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_delivery_events')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_inbound_due_owners', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_inbound_due_owners')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_inbound_usage_effects', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_inbound_usage_effects')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_inbox_addresses', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_inbox_addresses')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_inboxes', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_inboxes')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_messages', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_messages')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_outbound_provider_index', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_outbound_provider_index')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_outbound_provider_index_repair_owners', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_outbound_provider_index_repair_owners')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_sender_identities', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_sender_identities')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_sender_rules', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_sender_rules')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_threads', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_threads')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_user_graph_authority', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_user_graph_authority')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_user_graph_drop_approval', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_user_graph_drop_approval')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_verifications', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_verifications')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'entity_sources', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('entity_sources')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'feature_flag_exposure_rollups', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('feature_flag_exposure_rollups')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'feature_flag_user_overrides', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('feature_flag_user_overrides')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'feature_flags', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('feature_flags')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'invites', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('invites')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'jobs', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('jobs')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'mcp_agent_sessions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('mcp_agent_sessions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'mcp_memories', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('mcp_memories')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'mcp_memory_conversation_suppressions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('mcp_memory_conversation_suppressions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'mcp_server_settings', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('mcp_server_settings')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'mcp_user_server_instructions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('mcp_user_server_instructions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'oauth_connections', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('oauth_connections')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'package_codemod_run_items', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('package_codemod_run_items')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'package_codemod_runs', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('package_codemod_runs')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'package_invocation_tokens', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('package_invocation_tokens')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'package_scope_grants', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('package_scope_grants')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'package_service_states', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('package_service_states')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'passkeys', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('passkeys')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'password_resets', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('password_resets')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'pending_email_changes', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('pending_email_changes')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'permissions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('permissions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'platform_feedback', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('platform_feedback')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'published_bundle_artifacts', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('published_bundle_artifacts')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'remote_connector_settings', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('remote_connector_settings')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'repo_sessions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('repo_sessions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'role_permissions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('role_permissions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'roles', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('roles')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'saved_packages', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('saved_packages')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'secret_buckets', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('secret_buckets')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'secret_entries', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('secret_entries')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'stripe_webhook_events', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('stripe_webhook_events')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_attachments', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_attachments')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_daily_counters', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_daily_counters')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_delivery_events', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_delivery_events')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_graph_authority', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_graph_authority')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_messages', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_messages')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_threads', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_threads')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'usage_rollups', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('usage_rollups')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_activation_milestones', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_activation_milestones')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_follows', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_follows')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_integrations', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_integrations')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_oauth_apps', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_oauth_apps')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_openapi_binding_operations', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_openapi_binding_operations')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_openapi_bindings', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_openapi_bindings')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_package_run_successes', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_package_run_successes')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_roles', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_roles')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_storage_buckets', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_storage_buckets')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'users', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('users')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'value_buckets', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('value_buckets')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'value_entries', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('value_entries')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'verifications', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('verifications')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'webhook_endpoints', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('webhook_endpoints')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'workflow_runs', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('workflow_runs')
WHERE "table" = 'users';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	NOT EXISTS (
		SELECT child_table, from_column, to_column, on_update, on_delete, match
		FROM migration_0135_actual_users_foreign_keys
		EXCEPT
		SELECT child_table, from_column, to_column, on_update, on_delete, match
		FROM migration_0135_expected_users_foreign_keys
	)
	AND NOT EXISTS (
		SELECT child_table, from_column, to_column, on_update, on_delete, match
		FROM migration_0135_expected_users_foreign_keys
		EXCEPT
		SELECT child_table, from_column, to_column, on_update, on_delete, match
		FROM migration_0135_actual_users_foreign_keys
	)
THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM pragma_foreign_key_check;

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
CREATE UNIQUE INDEX idx_users_stable_user_id
	ON users(stable_user_id);
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

-- Reassert the complete rebuilt users contract before releasing temporary
-- snapshots. Any mismatch aborts and rolls the entire migration back.
INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 1 THEN 1 ELSE 0 END
FROM sqlite_schema schema_object
INNER JOIN migration_0135_expected_users_table_sql expected
	ON expected.phase = 'post'
	AND expected.normalized_sql = lower(
			replace(
				replace(
					replace(
						replace(
							replace(
								replace(
									replace(
										replace(schema_object.sql, ' ', ''),
										char(9),
										''
									),
									char(10),
									''
								),
								char(13),
								''
							),
							'"',
							''
						),
						char(96),
						''
					),
					'[',
					''
				),
				']',
				''
			)
		)
WHERE schema_object.type = 'table'
	AND schema_object.name = 'users';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	NOT EXISTS (
		SELECT cid, name, type, "notnull", dflt_value, pk, hidden
		FROM pragma_table_xinfo('users')
		EXCEPT
		SELECT cid, name, type, not_null, default_value, pk, hidden
		FROM migration_0135_expected_users_columns
		WHERE cid < 28
	)
	AND NOT EXISTS (
		SELECT cid, name, type, not_null, default_value, pk, hidden
		FROM migration_0135_expected_users_columns
		WHERE cid < 28
		EXCEPT
		SELECT cid, name, type, "notnull", dflt_value, pk, hidden
		FROM pragma_table_xinfo('users')
	)
THEN 1 ELSE 0 END;

DELETE FROM migration_0135_actual_users_indexes;
INSERT INTO migration_0135_actual_users_indexes (
	name, is_unique, origin, partial, sql
)
SELECT
	index_list.name, index_list."unique", index_list.origin,
	index_list.partial, schema_object.sql
FROM pragma_index_list('users') index_list
LEFT JOIN sqlite_schema schema_object
	ON schema_object.type = 'index'
	AND schema_object.name = index_list.name;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	NOT EXISTS (
		SELECT name, is_unique, origin, partial, sql
		FROM migration_0135_actual_users_indexes
		EXCEPT
		SELECT name, is_unique, origin, partial, sql
		FROM migration_0135_expected_users_indexes
		WHERE name != 'idx_users_mailbox_parity_checked'
	)
	AND NOT EXISTS (
		SELECT name, is_unique, origin, partial, sql
		FROM migration_0135_expected_users_indexes
		WHERE name != 'idx_users_mailbox_parity_checked'
		EXCEPT
		SELECT name, is_unique, origin, partial, sql
		FROM migration_0135_actual_users_indexes
	)
THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM sqlite_schema
WHERE type = 'trigger' AND tbl_name = 'users';

DELETE FROM migration_0135_actual_users_foreign_keys;
INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'account_write_lease_repairs', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('account_write_lease_repairs')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'account_write_leases', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('account_write_leases')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'agent_package_conversation_uses', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('agent_package_conversation_uses')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'archived_job_artifacts', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('archived_job_artifacts')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_activity_events', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_activity_events')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_bans', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_bans')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_forks', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_forks')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_listings', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_listings')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_ratings', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_ratings')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_reports', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_reports')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'community_stars', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('community_stars')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_attachments', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_attachments')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_delivery_alert_events', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_delivery_alert_events')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_delivery_events', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_delivery_events')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_inbound_due_owners', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_inbound_due_owners')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_inbound_usage_effects', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_inbound_usage_effects')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_inbox_addresses', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_inbox_addresses')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_inboxes', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_inboxes')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_messages', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_messages')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_outbound_provider_index', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_outbound_provider_index')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_outbound_provider_index_repair_owners', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_outbound_provider_index_repair_owners')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_sender_identities', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_sender_identities')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_sender_rules', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_sender_rules')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_threads', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_threads')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_user_graph_authority', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_user_graph_authority')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_user_graph_drop_approval', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_user_graph_drop_approval')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'email_verifications', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('email_verifications')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'entity_sources', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('entity_sources')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'feature_flag_exposure_rollups', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('feature_flag_exposure_rollups')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'feature_flag_user_overrides', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('feature_flag_user_overrides')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'feature_flags', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('feature_flags')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'invites', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('invites')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'jobs', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('jobs')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'mcp_agent_sessions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('mcp_agent_sessions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'mcp_memories', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('mcp_memories')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'mcp_memory_conversation_suppressions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('mcp_memory_conversation_suppressions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'mcp_server_settings', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('mcp_server_settings')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'mcp_user_server_instructions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('mcp_user_server_instructions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'oauth_connections', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('oauth_connections')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'package_codemod_run_items', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('package_codemod_run_items')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'package_codemod_runs', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('package_codemod_runs')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'package_invocation_tokens', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('package_invocation_tokens')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'package_scope_grants', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('package_scope_grants')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'package_service_states', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('package_service_states')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'passkeys', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('passkeys')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'password_resets', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('password_resets')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'pending_email_changes', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('pending_email_changes')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'permissions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('permissions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'platform_feedback', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('platform_feedback')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'published_bundle_artifacts', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('published_bundle_artifacts')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'remote_connector_settings', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('remote_connector_settings')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'repo_sessions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('repo_sessions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'role_permissions', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('role_permissions')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'roles', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('roles')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'saved_packages', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('saved_packages')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'secret_buckets', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('secret_buckets')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'secret_entries', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('secret_entries')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'stripe_webhook_events', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('stripe_webhook_events')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_attachments', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_attachments')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_daily_counters', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_daily_counters')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_delivery_events', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_delivery_events')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_graph_authority', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_graph_authority')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_messages', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_messages')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'system_email_threads', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('system_email_threads')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'usage_rollups', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('usage_rollups')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_activation_milestones', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_activation_milestones')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_follows', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_follows')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_integrations', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_integrations')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_oauth_apps', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_oauth_apps')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_openapi_binding_operations', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_openapi_binding_operations')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_openapi_bindings', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_openapi_bindings')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_package_run_successes', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_package_run_successes')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_roles', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_roles')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'user_storage_buckets', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('user_storage_buckets')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'users', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('users')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'value_buckets', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('value_buckets')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'value_entries', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('value_entries')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'verifications', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('verifications')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'webhook_endpoints', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('webhook_endpoints')
WHERE "table" = 'users';

INSERT INTO migration_0135_actual_users_foreign_keys (
	child_table, from_column, to_column, on_update, on_delete, match
)
SELECT 'workflow_runs', "from", "to", on_update, on_delete, match
FROM pragma_foreign_key_list('workflow_runs')
WHERE "table" = 'users';

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN
	NOT EXISTS (
		SELECT child_table, from_column, to_column, on_update, on_delete, match
		FROM migration_0135_actual_users_foreign_keys
		EXCEPT
		SELECT child_table, from_column, to_column, on_update, on_delete, match
		FROM migration_0135_expected_users_foreign_keys
	)
	AND NOT EXISTS (
		SELECT child_table, from_column, to_column, on_update, on_delete, match
		FROM migration_0135_expected_users_foreign_keys
		EXCEPT
		SELECT child_table, from_column, to_column, on_update, on_delete, match
		FROM migration_0135_actual_users_foreign_keys
	)
THEN 1 ELSE 0 END;

INSERT INTO migration_0135_legacy_email_graph_drop_guard (value)
SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END
FROM pragma_foreign_key_list('users');

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
DROP TABLE migration_0135_actual_users_foreign_keys;
DROP TABLE migration_0135_expected_users_foreign_keys;
DROP TABLE migration_0135_actual_users_indexes;
DROP TABLE migration_0135_expected_users_indexes;
DROP TABLE migration_0135_expected_users_columns;
DROP TABLE migration_0135_expected_users_table_sql;

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
