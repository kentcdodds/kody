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
	const deadlineMs = startedAt + reconciliationTimeBudgetMs
	let usersProcessed = 0
	let recovered = 0
	let cleaned = 0
	let errors = 0

	// Discover owner ids by oldest due work. All message/blob access below is
	// still performed under one explicit userId. Deferring failed attempts and
	// verification tombstones moves them behind older untouched users.
	const rows = await input.db
		.prepare(
			`SELECT user_id
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
			GROUP BY user_id
			ORDER BY MIN(
				CASE
					WHEN json_extract(detail_json, '$.state') = 'orphan-cleaned'
						THEN json_extract(detail_json, '$.cleanupRetryAt')
					ELSE COALESCE(
						json_extract(detail_json, '$.reconcileAfter'),
						created_at
					)
				END
			) ASC, user_id ASC
			LIMIT ?`,
		)
		.bind(
			cutoff,
			now.toISOString(),
			now.toISOString(),
			reconciliationUserBatchSize,
		)
		.all<{ user_id: string }>()
	for (const { user_id: userId } of rows.results ?? []) {
		if (Date.now() >= deadlineMs) break
		try {
			const result = await reconcileStaleInboundDeliveries({
				db: input.db,
				blobs: input.blobs,
				userId,
				now,
				deadlineMs,
			})
			recovered += result.recovered
			cleaned += result.cleaned
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
		errors,
		budgetExhausted: Date.now() >= deadlineMs,
	}
}
