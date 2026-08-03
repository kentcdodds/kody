import { staleInboundDeliveryAgeMs } from './inbound-delivery.ts'
import { reconcileInboundDeliveryEffectsForUser } from './inbound-effects.ts'
import {
	pruneUserExpiredInboundDedupePointers,
	reconcileUserStaleInboundDeliveries,
} from './inbound-delivery-reconciliation-authority.ts'
import { systemEmailOwnerId } from './email-owner.ts'
import { assertSystemEmailGraphAuthority } from './system-email-authority.ts'
import { inboundEffectLeaseMs } from './inbound-delivery-transitions.ts'
import {
	pruneSystemExpiredInboundDedupePointers,
	reconcileSystemStaleInboundDeliveries,
} from './system-inbound-delivery-authority.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'

const reconciliationUserBatchSize = 25
const reconciliationTimeBudgetMs = 10_000

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
	const userRows = await input.env.APP_DB.prepare(
		`WITH due_users AS (
				SELECT user_id, created_at AS due_at
				FROM email_delivery_events
				WHERE provider = 'cloudflare-email-routing'
					AND event_type = 'receive_started'
					AND user_id != ?
					AND created_at < ?
					AND (
						reconcile_after IS NULL
						OR reconcile_after <= ?
					)
					AND (
						state != 'orphan-cleaned'
						OR cleanup_retry_at <= ?
					)
				UNION ALL
				SELECT user_id, dedupe_expires_at
				FROM email_delivery_events
				WHERE provider = 'cloudflare-email-routing-dedupe'
					AND user_id != ?
					AND dedupe_expires_at <= ?
				UNION ALL
				SELECT user_id, COALESCE(
					usage_effect_retry_at,
					subscription_effect_retry_at,
					created_at
				)
				FROM email_delivery_events
				WHERE provider = 'cloudflare-email-routing'
					AND event_type = 'received'
					AND user_id != ?
					AND needs_effect_reconcile = 1
					AND fingerprint IS NOT NULL
					AND (
						(
							usage_effect_recorded_at IS NULL
							AND usage_effect_suppressed_at IS NULL
							AND (
								usage_effect_retry_at IS NULL
								OR usage_effect_retry_at <= ?
							)
							AND (
								usage_effect_lease IS NULL
								OR usage_effect_lease_at IS NULL
								OR usage_effect_lease_at < ?
							)
						)
						OR (
							(
								subscription_effect_state IS NULL
								OR subscription_effect_state NOT IN (
									'complete',
									'dead-letter'
								)
							)
							AND (
								subscription_effect_retry_at IS NULL
								OR subscription_effect_retry_at <= ?
							)
							AND (
								subscription_effect_state != 'processing'
								OR subscription_effect_lease_at IS NULL
								OR subscription_effect_lease_at < ?
							)
						)
					)
			)
			SELECT user_id, MIN(due_at) AS due_at
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
			systemEmailOwnerId,
			now.toISOString(),
			systemEmailOwnerId,
			now.toISOString(),
			effectLeaseExpiredBefore,
			now.toISOString(),
			effectLeaseExpiredBefore,
			reconciliationUserBatchSize,
		)
		.all<{ user_id: string; due_at: string }>()
	const systemDue = await input.env.APP_DB.prepare(
		`WITH due_work(due_at) AS (
			SELECT created_at
			FROM system_email_delivery_events
			WHERE
				provider = 'cloudflare-email-routing'
				AND event_type = 'receive_started'
				AND created_at < ?
				AND (reconcile_after IS NULL OR reconcile_after <= ?)
				AND (
					state = 'pending'
					OR (
						state = 'storing'
						AND (storage_lease_at IS NULL OR storage_lease_at < ?)
					)
					OR (
						state = 'cleaning'
						AND (cleanup_lease_at IS NULL OR cleanup_lease_at < ?)
					)
					OR (state = 'orphan-cleaned' AND cleanup_retry_at <= ?)
				)
			UNION ALL
			SELECT dedupe_expires_at
			FROM system_email_delivery_events
			WHERE
				provider = 'cloudflare-email-routing-dedupe'
				AND dedupe_expires_at <= ?
			UNION ALL
			SELECT COALESCE(
				usage_effect_retry_at, subscription_effect_retry_at, created_at
			)
			FROM system_email_delivery_events
			WHERE
				provider = 'cloudflare-email-routing'
				AND event_type = 'received'
				AND needs_effect_reconcile = 1
				AND fingerprint IS NOT NULL
				AND (
					(
						usage_effect_recorded_at IS NULL
						AND usage_effect_suppressed_at IS NULL
						AND (
							usage_effect_retry_at IS NULL OR usage_effect_retry_at <= ?
						)
						AND (
							usage_effect_lease IS NULL
							OR usage_effect_lease_at IS NULL
							OR usage_effect_lease_at < ?
						)
					)
					OR (
						COALESCE(subscription_effect_state, 'pending')
							NOT IN ('complete', 'dead-letter')
						AND (
							subscription_effect_retry_at IS NULL
							OR subscription_effect_retry_at <= ?
						)
						AND (
							COALESCE(subscription_effect_state, 'pending') !=
								'processing'
							OR subscription_effect_lease_at IS NULL
							OR subscription_effect_lease_at < ?
						)
					)
				)
		)
		SELECT ? AS user_id, MIN(due_at) AS due_at
		FROM due_work
		HAVING COUNT(*) > 0`,
	)
		.bind(
			cutoff,
			now.toISOString(),
			effectLeaseExpiredBefore,
			effectLeaseExpiredBefore,
			now.toISOString(),
			now.toISOString(),
			now.toISOString(),
			effectLeaseExpiredBefore,
			now.toISOString(),
			effectLeaseExpiredBefore,
			systemEmailOwnerId,
		)
		.first<{ user_id: string; due_at: string }>()
	const dueOwners = [
		...(userRows.results ?? []),
		...(systemDue ? [systemDue] : []),
	].sort(
		(left, right) =>
			left.due_at.localeCompare(right.due_at) ||
			left.user_id.localeCompare(right.user_id),
	)
	for (const { user_id: userId } of dueOwners) {
		if (Date.now() >= deadlineMs) break
		try {
			const reconcileUser = async () => {
				const systemOwner = userId === systemEmailOwnerId
				if (systemOwner) {
					await assertSystemEmailGraphAuthority(input.env.APP_DB)
				}
				const result = systemOwner
					? await reconcileSystemStaleInboundDeliveries({
							db: input.env.APP_DB,
							blobs: input.env.EMAIL_BLOBS,
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
