import { assertSystemEmailGraphAuthority } from './system-email-authority.ts'
import { commitSystemInboundEventMutation } from './system-inbound-delivery-mirror.ts'

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
	const detail = JSON.stringify({
		aggregate: true,
		day,
		count: 1,
		last_reason: input.reason,
		last_phase: input.phase,
		last_at: input.now.toISOString(),
	})
	await commitSystemInboundEventMutation({
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
						'$.count', COALESCE(json_extract(detail_json, '$.count'), 0) + 1,
						'$.last_reason', json_extract(excluded.detail_json, '$.last_reason'),
						'$.last_phase', json_extract(excluded.detail_json, '$.last_phase'),
						'$.last_at', json_extract(excluded.detail_json, '$.last_at')
					), updated_at = excluded.updated_at`,
			)
			.bind(
				aggregateId,
				input.inboxId,
				systemInboundProvider,
				detail,
				input.now.toISOString(),
				input.now.toISOString(),
			),
	})
	const aggregate = await input.db
		.prepare(
			`SELECT json_extract(detail_json, '$.count') AS count
			FROM system_email_delivery_events WHERE id = ?`,
		)
		.bind(aggregateId)
		.first<{ count: number }>()
	const count = Number(aggregate?.count ?? 1)
	if (count <= input.detailLimit) {
		const id = crypto.randomUUID()
		await commitSystemInboundEventMutation({
			db: input.db,
			eventId: id,
			dedicated: input.db
				.prepare(
					`INSERT INTO system_email_delivery_events (
						id, inbox_id, event_type, provider, detail_json,
						needs_effect_reconcile, created_at, updated_at
					) VALUES (?, ?, 'rejected', ?, ?, 0, ?, ?)`,
				)
				.bind(
					id,
					input.inboxId,
					systemInboundProvider,
					JSON.stringify({
						recipient: input.recipient,
						reason: input.reason,
						phase: input.phase,
					}),
					input.now.toISOString(),
					input.now.toISOString(),
				),
		})
	}
	return count
}
