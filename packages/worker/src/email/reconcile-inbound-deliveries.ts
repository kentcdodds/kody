import {
	reconcileStaleInboundDeliveries,
	staleInboundDeliveryAgeMs,
} from './inbound-delivery.ts'

const reconciliationUserBatchSize = 25
const reconciliationTimeBudgetMs = 10_000

export async function sweepStaleInboundDeliveries(input: {
	db: D1Database
	blobs: R2Bucket
	now?: Date
}) {
	const now = input.now ?? new Date()
	const cutoff = new Date(
		now.getTime() - staleInboundDeliveryAgeMs,
	).toISOString()
	const startedAt = Date.now()
	let afterUserId = ''
	let usersProcessed = 0
	let recovered = 0
	let cleaned = 0
	let errors = 0

	while (Date.now() - startedAt < reconciliationTimeBudgetMs) {
		// This query discovers owner ids only. Every ledger/message/blob read or
		// mutation happens in reconcileStaleInboundDeliveries with that userId.
		const rows = await input.db
			.prepare(
				`SELECT DISTINCT user_id
				FROM email_delivery_events
				WHERE user_id > ?
					AND provider = 'cloudflare-email-routing'
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
				ORDER BY user_id ASC
				LIMIT ?`,
			)
			.bind(
				afterUserId,
				cutoff,
				now.toISOString(),
				now.toISOString(),
				reconciliationUserBatchSize,
			)
			.all<{ user_id: string }>()
		const userIds = (rows.results ?? []).map((row) => row.user_id)
		if (userIds.length === 0) break
		for (const userId of userIds) {
			if (Date.now() - startedAt >= reconciliationTimeBudgetMs) {
				return {
					usersProcessed,
					recovered,
					cleaned,
					errors,
					budgetExhausted: true,
				}
			}
			try {
				const result = await reconcileStaleInboundDeliveries({
					db: input.db,
					blobs: input.blobs,
					userId,
					now,
				})
				recovered += result.recovered
				cleaned += result.cleaned
			} catch (error) {
				errors += 1
				console.warn('inbound-email-user-reconciliation-failed', userId, error)
			}
			usersProcessed += 1
		}
		afterUserId = userIds.at(-1) ?? afterUserId
		if (userIds.length < reconciliationUserBatchSize) break
	}

	return {
		usersProcessed,
		recovered,
		cleaned,
		errors,
		budgetExhausted: Date.now() - startedAt >= reconciliationTimeBudgetMs,
	}
}
