import { staleInboundDeliveryAgeMs } from './inbound-delivery.ts'
import { reconcileInboundDeliveryEffectsForUser } from './inbound-effects.ts'
import {
	pruneUserExpiredInboundDedupePointers,
	reconcileUserStaleInboundDeliveries,
} from './inbound-delivery-reconciliation-authority.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import {
	pruneSystemExpiredInboundDedupePointers,
	reconcileSystemStaleInboundDeliveries,
} from './system-inbound-delivery-authority.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'

const reconciliationUserBatchSize = 25
const reconciliationTimeBudgetMs = 10_000
const inboundEffectLeaseMs = 5 * 60 * 1000

export async function sweepStaleInboundDeliveries(input: {
	env: Pick<
		Env,
		| 'APP_DB'
		| 'EMAIL_BLOBS'
		| 'BUNDLE_ARTIFACTS_KV'
		| 'APP_BASE_URL'
		| 'USAGE_EVENTS'
		| 'MAILBOX'
		| 'USER_METER'
	>
	now?: Date
}) {
	const now = input.now ?? new Date()
	const cutoff = new Date(
		now.getTime() - staleInboundDeliveryAgeMs,
	).toISOString()
	const startedAt = Date.now()
	const deadlineMs = startedAt + reconciliationTimeBudgetMs
	const effectLeaseExpiredBefore = new Date(
		now.getTime() - inboundEffectLeaseMs,
	).toISOString()
	let usersProcessed = 0
	let recovered = 0
	let cleaned = 0
	let pointersPruned = 0
	let effectsProcessed = 0
	let errors = 0

	// Discover owner ids by oldest due work. All message/blob access below is
	// still performed under one explicit userId. Deferring failed attempts and
	// verification tombstones moves them behind older untouched users.
	const rows = await input.env.APP_DB.prepare(
		`WITH authority(system_owner_id) AS (VALUES (?)),
			projected_events AS (
				SELECT email_delivery_events.*,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.reconcileAfter')
						ELSE reconcile_after
					END AS authority_reconcile_after,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.state')
						ELSE state
					END AS authority_state,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.cleanupRetryAt')
						ELSE cleanup_retry_at
					END AS authority_cleanup_retry_at,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.dedupeExpiresAt')
						ELSE dedupe_expires_at
					END AS authority_dedupe_expires_at,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.fingerprint')
						ELSE fingerprint
					END AS authority_fingerprint,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.usageEffectRecordedAt')
						ELSE usage_effect_recorded_at
					END AS authority_usage_recorded_at,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.usageEffectSuppressedAt')
						ELSE usage_effect_suppressed_at
					END AS authority_usage_suppressed_at,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.usageEffectRetryAt')
						ELSE usage_effect_retry_at
					END AS authority_usage_retry_at,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.usageEffectLease')
						ELSE usage_effect_lease
					END AS authority_usage_lease,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.usageEffectLeaseAt')
						ELSE usage_effect_lease_at
					END AS authority_usage_lease_at,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.subscriptionEffectState')
						ELSE subscription_effect_state
					END AS authority_subscription_state,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.subscriptionEffectRetryAt')
						ELSE subscription_effect_retry_at
					END AS authority_subscription_retry_at,
					CASE WHEN user_id = system_owner_id
						THEN json_extract(detail_json, '$.subscriptionEffectLeaseAt')
						ELSE subscription_effect_lease_at
					END AS authority_subscription_lease_at
				FROM email_delivery_events
				CROSS JOIN authority
			),
			due_users AS (
				SELECT user_id, created_at AS due_at
				FROM projected_events
				WHERE provider = 'cloudflare-email-routing'
					AND event_type = 'receive_started'
					AND created_at < ?
					AND (
						authority_reconcile_after IS NULL
						OR authority_reconcile_after <= ?
					)
					AND (
						authority_state != 'orphan-cleaned'
						OR authority_cleanup_retry_at <= ?
					)
				UNION ALL
				SELECT user_id, authority_dedupe_expires_at
				FROM projected_events
				WHERE provider = 'cloudflare-email-routing-dedupe'
					AND authority_dedupe_expires_at <= ?
				UNION ALL
				SELECT user_id, COALESCE(
					authority_usage_retry_at,
					authority_subscription_retry_at,
					created_at
				)
				FROM projected_events
				WHERE provider = 'cloudflare-email-routing'
					AND event_type = 'received'
					AND needs_effect_reconcile = 1
					AND authority_fingerprint IS NOT NULL
					AND (
						(
							authority_usage_recorded_at IS NULL
							AND authority_usage_suppressed_at IS NULL
							AND (
								authority_usage_retry_at IS NULL
								OR authority_usage_retry_at <= ?
							)
							AND (
								authority_usage_lease IS NULL
								OR authority_usage_lease_at IS NULL
								OR authority_usage_lease_at < ?
							)
						)
						OR (
							(
								authority_subscription_state IS NULL
								OR authority_subscription_state NOT IN (
									'complete',
									'dead-letter'
								)
							)
							AND (
								authority_subscription_retry_at IS NULL
								OR authority_subscription_retry_at <= ?
							)
							AND (
								authority_subscription_state != 'processing'
								OR authority_subscription_lease_at IS NULL
								OR authority_subscription_lease_at < ?
							)
						)
					)
			)
			SELECT user_id
			FROM due_users
			GROUP BY user_id
			ORDER BY MIN(due_at) ASC, user_id ASC
			LIMIT ?`,
	)
		.bind(
			systemEmailOwnerId,
			cutoff,
			now.toISOString(),
			now.toISOString(),
			now.toISOString(),
			now.toISOString(),
			effectLeaseExpiredBefore,
			now.toISOString(),
			effectLeaseExpiredBefore,
			reconciliationUserBatchSize,
		)
		.all<{ user_id: string }>()
	for (const { user_id: userId } of rows.results ?? []) {
		if (Date.now() >= deadlineMs) break
		try {
			const reconcileUser = async () => {
				const systemOwner = userId === systemEmailOwnerId
				const result = systemOwner
					? await reconcileSystemStaleInboundDeliveries({
							db: input.env.APP_DB,
							blobs: input.env.EMAIL_BLOBS,
							userId,
							now,
							deadlineMs,
						})
					: await reconcileUserStaleInboundDeliveries({
							env: input.env,
							userId,
							now,
							deadlineMs,
						})
				const pruned = systemOwner
					? await pruneSystemExpiredInboundDedupePointers({
							db: input.env.APP_DB,
							userId,
							now,
						})
					: await pruneUserExpiredInboundDedupePointers({
							env: input.env,
							userId,
							now,
						})
				const effectResult = await reconcileInboundDeliveryEffectsForUser({
					env: input.env,
					userId,
					now,
				})
				return { result, pruned, effectResult }
			}
			const { result, pruned, effectResult } =
				userId === systemEmailOwnerId
					? await reconcileUser()
					: await withAccountWriteLease({
							db: input.env.APP_DB,
							stableUserId: userId,
							write: reconcileUser,
						})
			recovered += result.recovered
			cleaned += result.cleaned
			pointersPruned += pruned
			effectsProcessed += effectResult.processed
			errors += effectResult.errors
			usersProcessed += 1
			if (result.budgetExhausted) break
		} catch (error) {
			errors += 1
			usersProcessed += 1
			console.warn('inbound-email-user-reconciliation-failed', userId, error)
		}
	}

	return {
		usersProcessed,
		recovered,
		cleaned,
		pointersPruned,
		effectsProcessed,
		errors,
		budgetExhausted: Date.now() >= deadlineMs,
	}
}
