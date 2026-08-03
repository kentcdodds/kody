import { systemEmailOwnerId } from './email-owner.ts'

/**
 * Complete compatibility upsert for one authoritative event. Callers place
 * this immediately after the dedicated mutation in the same transactional D1
 * batch, so a mirror failure rolls back the authority write. The user_id CASE
 * deliberately violates its NOT NULL constraint on a same-id foreign-owner
 * collision instead of allowing a system write to take over a user row.
 */
export function legacySystemInboundEventMirrorStatement(
	db: D1Database,
	eventId: string,
) {
	return db
		.prepare(
			`INSERT INTO email_delivery_events (
				id, message_id, user_id, inbox_id, event_type, provider,
				provider_message_id, provider_event_id, detail_json, created_at,
				needs_effect_reconcile, usage_effect_recorded_at, usage_month,
				usage_bytes, usage_duration_ms, state, fingerprint, storage_lease,
				storage_lease_at, cleanup_lease, cleanup_lease_at, cleanup_retry_at,
				expected_attachment_count, finalization_token, reconcile_after,
				dedupe_expires_at, usage_effect_suppressed_at, usage_started_at,
				usage_effect_retry_at, usage_effect_lease, usage_effect_lease_at,
				subscription_effect_state, subscription_effect_lease,
				subscription_effect_lease_at, subscription_effect_retry_at,
				subscription_effect_attempt_count,
				subscription_effect_dead_letter_at,
				subscription_effect_last_error, updated_at
			)
			SELECT
				id, message_id, ?, inbox_id, event_type, provider,
				provider_message_id, provider_event_id, detail_json, created_at,
				needs_effect_reconcile, usage_effect_recorded_at, usage_month,
				usage_bytes, usage_duration_ms, state, fingerprint, storage_lease,
				storage_lease_at, cleanup_lease, cleanup_lease_at, cleanup_retry_at,
				expected_attachment_count, finalization_token, reconcile_after,
				dedupe_expires_at, usage_effect_suppressed_at, usage_started_at,
				usage_effect_retry_at, usage_effect_lease, usage_effect_lease_at,
				subscription_effect_state, subscription_effect_lease,
				subscription_effect_lease_at, subscription_effect_retry_at,
				subscription_effect_attempt_count,
				subscription_effect_dead_letter_at,
				subscription_effect_last_error, updated_at
			FROM system_email_delivery_events
			WHERE id = ?
			ON CONFLICT(id) DO UPDATE SET
				message_id = excluded.message_id,
				user_id = CASE
					WHEN email_delivery_events.user_id = excluded.user_id
					THEN excluded.user_id
					ELSE NULL
				END,
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
				subscription_effect_last_error =
					excluded.subscription_effect_last_error,
				updated_at = excluded.updated_at`,
		)
		.bind(systemEmailOwnerId, eventId)
}
