import { assertSystemEmailGraphAuthority } from './system-email-authority.ts'
import { commitSystemEmailGraphMutations } from './system-email-graph-transaction.ts'
import { systemInboundEventMutation } from './system-inbound-delivery-mirror.ts'

const systemInboundProvider = 'cloudflare-email-routing'

export async function recordBoundedSystemEmailRejection(input: {
	db: D1Database
	inboxId: string
	recipient: string
	reason: string
	phase: string
	now: Date
	detailLimit: number
}) {
	await assertSystemEmailGraphAuthority(input.db)
	const day = input.now.toISOString().slice(0, 10)
	const aggregateId = `email-rejections:${input.inboxId}:${day}`
	const detailId = crypto.randomUUID()
	const now = input.now.toISOString()
	const detail = JSON.stringify({
		aggregate: true,
		day,
		count: 1,
		last_reason: input.reason,
		last_phase: input.phase,
		last_at: now,
	})
	const { mutationResults } = await commitSystemEmailGraphMutations({
		db: input.db,
		mutations: [
			systemInboundEventMutation({
				db: input.db,
				eventId: aggregateId,
				dedicated: input.db
					.prepare(
						`INSERT INTO system_email_delivery_events (
							id, inbox_id, event_type, provider, detail_json,
							needs_effect_reconcile, created_at, updated_at
						) VALUES (?, ?, 'rejected', ?, ?, 0, ?, ?)
						ON CONFLICT(id) DO UPDATE SET
							detail_json = json_set(
								detail_json,
								'$.count',
								COALESCE(json_extract(detail_json, '$.count'), 0) + 1,
								'$.last_reason',
								json_extract(excluded.detail_json, '$.last_reason'),
								'$.last_phase',
								json_extract(excluded.detail_json, '$.last_phase'),
								'$.last_at',
								json_extract(excluded.detail_json, '$.last_at')
							),
							updated_at = excluded.updated_at
						RETURNING CAST(
							json_extract(detail_json, '$.count') AS INTEGER
						) AS count`,
					)
					.bind(
						aggregateId,
						input.inboxId,
						systemInboundProvider,
						detail,
						now,
						now,
					),
			}),
			systemInboundEventMutation({
				db: input.db,
				eventId: detailId,
				dedicated: input.db
					.prepare(
						`INSERT INTO system_email_delivery_events (
						id, inbox_id, event_type, provider, detail_json,
						needs_effect_reconcile, created_at, updated_at
					)
					SELECT ?, ?, 'rejected', ?, ?, 0, ?, ?
					FROM system_email_delivery_events aggregate
					WHERE aggregate.id = ?
						AND CAST(
							json_extract(aggregate.detail_json, '$.count') AS INTEGER
						) <= ?`,
					)
					.bind(
						detailId,
						input.inboxId,
						systemInboundProvider,
						JSON.stringify({
							recipient: input.recipient,
							reason: input.reason,
							phase: input.phase,
						}),
						now,
						now,
						aggregateId,
						input.detailLimit,
					),
			}),
		],
	})
	const aggregateResult = mutationResults[0]?.dedicated
	const count = Number(
		(aggregateResult?.results?.[0] as { count?: unknown } | undefined)?.count,
	)
	if (!Number.isSafeInteger(count) || count < 1) {
		throw new Error(
			'System email rejection aggregate returned an invalid count.',
		)
	}
	return count
}
