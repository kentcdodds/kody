-- Step 4b authority marker. The dedicated system_email_* graph is now the
-- system:email read/write authority. Legacy shared rows remain atomic rollback
-- mirrors through step 5 and are intentionally not deleted by this migration.

-- 0130 copied the promoted delivery columns as they existed. Older live rows
-- can still carry transition state only in detail_json, so materialize every
-- promoted state/effect field before any 4b query is allowed to use its index.
UPDATE system_email_delivery_events
SET
	usage_effect_recorded_at = COALESCE(
		usage_effect_recorded_at,
		json_extract(detail_json, '$.usageEffectRecordedAt')
	),
	usage_month = COALESCE(usage_month, json_extract(detail_json, '$.usageMonth')),
	usage_bytes = COALESCE(usage_bytes, json_extract(detail_json, '$.usageBytes')),
	usage_duration_ms = COALESCE(
		usage_duration_ms,
		json_extract(detail_json, '$.usageDurationMs')
	),
	state = COALESCE(state, json_extract(detail_json, '$.state')),
	fingerprint = COALESCE(
		fingerprint,
		json_extract(detail_json, '$.fingerprint')
	),
	storage_lease = COALESCE(
		storage_lease,
		json_extract(detail_json, '$.storageLease')
	),
	storage_lease_at = COALESCE(
		storage_lease_at,
		json_extract(detail_json, '$.storageLeaseAt')
	),
	cleanup_lease = COALESCE(
		cleanup_lease,
		json_extract(detail_json, '$.cleanupLease')
	),
	cleanup_lease_at = COALESCE(
		cleanup_lease_at,
		json_extract(detail_json, '$.cleanupLeaseAt')
	),
	cleanup_retry_at = COALESCE(
		cleanup_retry_at,
		json_extract(detail_json, '$.cleanupRetryAt')
	),
	expected_attachment_count = COALESCE(
		expected_attachment_count,
		json_extract(detail_json, '$.expectedAttachmentCount')
	),
	finalization_token = COALESCE(
		finalization_token,
		json_extract(detail_json, '$.finalizationToken')
	),
	reconcile_after = COALESCE(
		reconcile_after,
		json_extract(detail_json, '$.reconcileAfter')
	),
	dedupe_expires_at = COALESCE(
		dedupe_expires_at,
		json_extract(detail_json, '$.dedupeExpiresAt')
	),
	usage_effect_suppressed_at = COALESCE(
		usage_effect_suppressed_at,
		json_extract(detail_json, '$.usageEffectSuppressedAt')
	),
	usage_started_at = COALESCE(
		usage_started_at,
		json_extract(detail_json, '$.usageStartedAt')
	),
	usage_effect_retry_at = COALESCE(
		usage_effect_retry_at,
		json_extract(detail_json, '$.usageEffectRetryAt')
	),
	usage_effect_lease = COALESCE(
		usage_effect_lease,
		json_extract(detail_json, '$.usageEffectLease')
	),
	usage_effect_lease_at = COALESCE(
		usage_effect_lease_at,
		json_extract(detail_json, '$.usageEffectLeaseAt')
	),
	subscription_effect_state = COALESCE(
		subscription_effect_state,
		json_extract(detail_json, '$.subscriptionEffectState')
	),
	subscription_effect_lease = COALESCE(
		subscription_effect_lease,
		json_extract(detail_json, '$.subscriptionEffectLease')
	),
	subscription_effect_lease_at = COALESCE(
		subscription_effect_lease_at,
		json_extract(detail_json, '$.subscriptionEffectLeaseAt')
	),
	subscription_effect_retry_at = COALESCE(
		subscription_effect_retry_at,
		json_extract(detail_json, '$.subscriptionEffectRetryAt')
	),
	subscription_effect_attempt_count = COALESCE(
		subscription_effect_attempt_count,
		json_extract(detail_json, '$.subscriptionEffectAttemptCount')
	),
	subscription_effect_dead_letter_at = COALESCE(
		subscription_effect_dead_letter_at,
		json_extract(detail_json, '$.subscriptionEffectDeadLetterAt')
	),
	subscription_effect_last_error = COALESCE(
		subscription_effect_last_error,
		json_extract(detail_json, '$.subscriptionEffectLastError')
	),
	updated_at = COALESCE(
		updated_at,
		json_extract(detail_json, '$.updatedAt'),
		created_at
	);

CREATE TABLE IF NOT EXISTS system_email_graph_authority (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	authority TEXT NOT NULL CHECK (authority = 'dedicated'),
	cutover_at TEXT NOT NULL,
	provider_link_count INTEGER NOT NULL CHECK (provider_link_count = 0)
);

-- The marker write is also the deploy gate. Any system-owned provider index
-- row or provider-linked legacy/dedicated message violates the CHECK and aborts
-- the migration instead of enabling a graph that cannot resolve those links.
INSERT INTO system_email_graph_authority (
	singleton,
	authority,
	cutover_at,
	provider_link_count
)
SELECT
	1,
	'dedicated',
	CURRENT_TIMESTAMP,
	(
		SELECT COUNT(*)
		FROM email_outbound_provider_index provider_index
		WHERE provider_index.user_id = 'system:email'
			OR EXISTS (
				SELECT 1
				FROM email_messages legacy_message
				WHERE legacy_message.id = provider_index.message_id
					AND legacy_message.user_id = 'system:email'
			)
	) + (
		SELECT COUNT(*)
		FROM email_messages legacy_message
		WHERE legacy_message.user_id = 'system:email'
			AND legacy_message.provider_message_id IS NOT NULL
	) + (
		SELECT COUNT(*)
		FROM system_email_messages dedicated_message
		WHERE dedicated_message.provider_message_id IS NOT NULL
	)
ON CONFLICT(singleton) DO UPDATE SET
	authority = excluded.authority,
	cutover_at = excluded.cutover_at,
	provider_link_count = excluded.provider_link_count;
