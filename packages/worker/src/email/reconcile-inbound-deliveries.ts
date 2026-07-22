import {
	pruneExpiredInboundDedupePointers,
	reconcileStaleInboundDeliveries,
	staleInboundDeliveryAgeMs,
} from './inbound-delivery.ts'
import { reconcileInboundDeliveryEffectsForUser } from './inbound-effects.ts'

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
	>
	now?: Date
}) {
	const now = input.now ?? new Date()
	const cutoff = new Date(
		now.getTime() - staleInboundDeliveryAgeMs,
	).toISOString()
	const startedAt = Date.now()
	const deadlineMs = startedAt + reconciliationTimeBudgetMs
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
		`WITH due_users AS (
				SELECT user_id, created_at AS due_at
				FROM email_delivery_events
				WHERE provider = 'cloudflare-email-routing'
					AND event_type = 'receive_started'
					AND created_at < ?
					AND (
						json_extract(detail_json, '$.reconcileAfter') IS NULL
						OR json_extract(detail_json, '$.reconcileAfter') <= ?
					)
					AND (
						json_extract(detail_json, '$.state') != 'orphan-cleaned'
						OR json_extract(detail_json, '$.cleanupRetryAt') <= ?
					)
				UNION ALL
				SELECT user_id, json_extract(detail_json, '$.dedupeExpiresAt')
				FROM email_delivery_events
				WHERE provider = 'cloudflare-email-routing-dedupe'
					AND json_extract(detail_json, '$.dedupeExpiresAt') <= ?
				UNION ALL
				SELECT user_id, created_at
				FROM email_delivery_events
				WHERE provider = 'cloudflare-email-routing'
					AND event_type = 'received'
					AND (
						json_extract(detail_json, '$.usageEffectClaimedAt') IS NULL
						OR json_extract(detail_json, '$.subscriptionEffectState') IS NULL
						OR json_extract(detail_json, '$.subscriptionEffectState') != 'complete'
					)
			)
			SELECT user_id
			FROM due_users
			GROUP BY user_id
			ORDER BY MIN(due_at) ASC, user_id ASC
			LIMIT ?`,
	)
		.bind(
			cutoff,
			now.toISOString(),
			now.toISOString(),
			now.toISOString(),
			reconciliationUserBatchSize,
		)
		.all<{ user_id: string }>()
	for (const { user_id: userId } of rows.results ?? []) {
		if (Date.now() >= deadlineMs) break
		try {
			const result = await reconcileStaleInboundDeliveries({
				db: input.env.APP_DB,
				blobs: input.env.EMAIL_BLOBS,
				userId,
				now,
				deadlineMs,
			})
			recovered += result.recovered
			cleaned += result.cleaned
			pointersPruned += await pruneExpiredInboundDedupePointers({
				db: input.env.APP_DB,
				userId,
				now,
			})
			const effectResult = await reconcileInboundDeliveryEffectsForUser({
				env: input.env,
				userId,
				now,
			})
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
