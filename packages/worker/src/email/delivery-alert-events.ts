export const emailDeliveryAlertEventRetentionDays = 7

export async function recordDeliveryAlertEvent(input: {
	db: D1Database
	providerEventId: string
	provider: string
	eventType: 'bounced' | 'complained'
	occurredAt: string
	now?: Date
}) {
	await input.db
		.prepare(
			`INSERT INTO email_delivery_alert_events (
				provider_event_id, provider, event_type, occurred_at,
				owner_hash, created_at
			) VALUES (?, ?, ?, ?, NULL, ?)
			ON CONFLICT(provider_event_id) DO NOTHING`,
		)
		.bind(
			input.providerEventId,
			input.provider,
			input.eventType,
			input.occurredAt,
			(input.now ?? new Date()).toISOString(),
		)
		.run()
}

export async function pruneDeliveryAlertEvents(input: {
	db: D1Database
	now?: Date
	limit?: number
}) {
	const now = input.now ?? new Date()
	const cutoff = new Date(
		now.getTime() - emailDeliveryAlertEventRetentionDays * 24 * 60 * 60 * 1000,
	).toISOString()
	const result = await input.db
		.prepare(
			`DELETE FROM email_delivery_alert_events
			WHERE provider_event_id IN (
				SELECT provider_event_id
				FROM email_delivery_alert_events
				WHERE occurred_at < ?
				ORDER BY occurred_at ASC, provider_event_id ASC
				LIMIT ?
			)`,
		)
		.bind(cutoff, input.limit ?? 250)
		.run()
	return Number(result.meta.changes ?? 0)
}

export async function loadDeliveryAlertEventsHealth(input: {
	db: D1Database
	now?: Date
}): Promise<{
	retainedEvents: number
	lastHourEvents: number
	oldestEventAt: string | null
}> {
	const now = input.now ?? new Date()
	const windowStart = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
	const row = await input.db
		.prepare(
			`SELECT
				COUNT(*) AS retained_events,
				COALESCE(SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END), 0)
					AS last_hour_events,
				MIN(occurred_at) AS oldest_event_at
			FROM email_delivery_alert_events`,
		)
		.bind(windowStart)
		.first<{
			retained_events: number
			last_hour_events: number
			oldest_event_at: string | null
		}>()
	return {
		retainedEvents: Number(row?.retained_events ?? 0),
		lastHourEvents: Number(row?.last_hour_events ?? 0),
		oldestEventAt: row?.oldest_event_at ?? null,
	}
}
