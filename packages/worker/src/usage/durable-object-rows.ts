import { recordUsage, type UsageEnv } from './record-usage.ts'

export const durableObjectRowsReadEventType = 'durable_object_rows_read'

/**
 * Record StorageRunner SQLite `rowsRead` for monthly overage. Never throws.
 * Zero-row statements are skipped so a no-op query cannot inflate the
 * count by the `eventCount` floor of 1.
 */
export async function recordDurableObjectRowsRead(input: {
	env: UsageEnv
	userId: string
	doClass: string
	rowsRead: number
	outcome?: 'success' | 'error'
}): Promise<void> {
	try {
		if (!input.userId) return
		if (!Number.isFinite(input.rowsRead) || input.rowsRead < 1) return
		await recordUsage(input.env, {
			userId: input.userId,
			eventType: durableObjectRowsReadEventType,
			entityId: input.doClass,
			eventCount: Math.trunc(input.rowsRead),
			outcome: input.outcome ?? 'success',
		})
	} catch (error) {
		console.debug('durable-object-rows-read-failed', error)
	}
}
