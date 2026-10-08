export const systemInboundProvider = 'cloudflare-email-routing'
export const systemInboundDedupeProvider = 'cloudflare-email-routing-dedupe'
export const systemInboundDeletedRejectionReason = 'Message deleted.'

export function systemInboundDedupePointerId(fingerprint: string) {
	return `email-inbound-dedupe:${fingerprint}`
}

export async function listSystemInboundDedupePointerIdsForMessages(input: {
	db: D1Database
	messageIds: ReadonlyArray<string>
}): Promise<Array<string>> {
	if (input.messageIds.length === 0) return []
	const placeholders = input.messageIds.map(() => '?').join(', ')
	const charged = await input.db
		.prepare(
			`SELECT DISTINCT fingerprint
			FROM system_email_delivery_events
			WHERE message_id IN (${placeholders})
				AND fingerprint IS NOT NULL
				AND fingerprint != ''`,
		)
		.bind(...input.messageIds)
		.all<{ fingerprint: string }>()
	const pointers = await input.db
		.prepare(
			`SELECT id
			FROM system_email_delivery_events
			WHERE provider = ?
				AND json_extract(detail_json, '$.messageId') IN (${placeholders})`,
		)
		.bind(systemInboundDedupeProvider, ...input.messageIds)
		.all<{ id: string }>()
	const ids = new Set<string>()
	for (const row of charged.results ?? []) {
		ids.add(systemInboundDedupePointerId(row.fingerprint))
	}
	for (const row of pointers.results ?? []) {
		ids.add(row.id)
	}
	return [...ids]
}

export function tombstoneSystemInboundDedupePointerStatement(input: {
	db: D1Database
	pointerId: string
	now: string
}) {
	return input.db
		.prepare(
			`UPDATE system_email_delivery_events
			SET event_type = 'rejected',
				state = 'rejected',
				detail_json = json_set(
					detail_json, '$.state', 'rejected', '$.rejectionReason', ?
				),
				updated_at = ?
			WHERE id = ? AND provider = ?`,
		)
		.bind(
			systemInboundDeletedRejectionReason,
			input.now,
			input.pointerId,
			systemInboundDedupeProvider,
		)
}

export async function systemInboundDedupeTombstoneStatements(input: {
	db: D1Database
	messageIds: ReadonlyArray<string>
	now?: Date
}): Promise<Array<D1PreparedStatement>> {
	const pointerIds = await listSystemInboundDedupePointerIdsForMessages(input)
	if (pointerIds.length === 0) return []
	const now = (input.now ?? new Date()).toISOString()
	return pointerIds.map((pointerId) =>
		tombstoneSystemInboundDedupePointerStatement({
			db: input.db,
			pointerId,
			now,
		}),
	)
}
