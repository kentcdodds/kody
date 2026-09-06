import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'

export const computeOverageUsageMetrics = [
	'dynamic_worker_day',
	'durable_object_rows_read',
] as const

export type MonthlyComputeUsage = {
	uniqueWorkerDays: number
	durableObjectRowsRead: number
}

function nonNegativeCount(value: number | null | undefined): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return 0
	}
	return Math.trunc(value)
}

export async function readMonthlyComputeUsage(input: {
	db: D1Database
	stableUserId: string
	month: string
}): Promise<MonthlyComputeUsage> {
	const rows = await input.db
		.prepare(
			`SELECT metric, event_count
			 FROM usage_rollups
			 WHERE user_id = ?
				AND month = ?
				AND metric IN ('dynamic_worker_day', 'durable_object_rows_read')`,
		)
		.bind(input.stableUserId, input.month)
		.all<{ metric: string; event_count: number }>()
	let uniqueWorkerDays = 0
	let durableObjectRowsRead = 0
	for (const row of rows.results ?? []) {
		const count = nonNegativeCount(row.event_count)
		if (row.metric === 'dynamic_worker_day') uniqueWorkerDays = count
		if (row.metric === 'durable_object_rows_read') {
			durableObjectRowsRead = count
		}
	}
	return { uniqueWorkerDays, durableObjectRowsRead }
}

export function currentUtcMonthKey(now: Date): string {
	return utcMonthKey(now)
}
