/**
 * Admin funnel windows. Prefers Analytics Engine SQL when the binding and
 * Cloudflare REST credentials are present (same path as email insights).
 * Falls back to D1 `funnel_events`, which is also what local dev writes.
 * Failures return zeros so `/admin/insights` still renders.
 */

import {
	funnelStageOrder,
	type AdminFunnelStage,
	type AdminFunnelSummary,
	type FunnelEventName,
	isFunnelEventName,
} from '#universal/funnel-events.ts'
import { queryAnalyticsEngineSql } from '#worker/usage/aggregate-rollups.ts'
import {
	funnelDatasetName,
	type FunnelEventEnv,
} from './record-funnel-event.ts'

const dayMs = 24 * 60 * 60 * 1000

type CountRow = {
	event: string
	users: number | string
	events: number | string
}

function emptyStages(): Array<AdminFunnelStage> {
	return funnelStageOrder.map((event) => ({ event, days7: 0, days28: 0 }))
}

function toCount(value: number | string | null | undefined) {
	const parsed = Number(value ?? 0)
	return Number.isFinite(parsed) ? Math.round(parsed) : 0
}

function stageCount(row: CountRow) {
	const users = toCount(row.users)
	const events = toCount(row.events)
	// signup_started has no account yet, so distinct user ids are empty.
	if (row.event === 'signup_started') return events
	return users
}

function mergeWindows(input: {
	days7: ReadonlyArray<CountRow>
	days28: ReadonlyArray<CountRow>
}): Array<AdminFunnelStage> {
	const byEvent = new Map<FunnelEventName, AdminFunnelStage>()
	for (const event of funnelStageOrder) {
		byEvent.set(event, { event, days7: 0, days28: 0 })
	}
	for (const row of input.days28) {
		if (!isFunnelEventName(row.event)) continue
		const stage = byEvent.get(row.event)
		if (!stage) continue
		stage.days28 = stageCount(row)
	}
	for (const row of input.days7) {
		if (!isFunnelEventName(row.event)) continue
		const stage = byEvent.get(row.event)
		if (!stage) continue
		stage.days7 = stageCount(row)
	}
	return funnelStageOrder.map(
		(event) => byEvent.get(event) ?? { event, days7: 0, days28: 0 },
	)
}

function analyticsQuery(dataset: string, days: number) {
	return `
SELECT
	blob1 AS event,
	count(DISTINCT blob2) AS users,
	sum(_sample_interval) AS events
FROM ${dataset}
WHERE timestamp > NOW() - INTERVAL '${days}' DAY
	AND blob1 != ''
GROUP BY event
FORMAT JSON
`.trim()
}

async function readD1Window(
	db: D1Database,
	sinceIso: string,
): Promise<Array<CountRow>> {
	const { results } = await db
		.prepare(
			`SELECT event,
				COUNT(DISTINCT CASE WHEN user_id != '' THEN user_id END) AS users,
				COUNT(*) AS events
			 FROM funnel_events
			 WHERE occurred_at >= ?
			 GROUP BY event`,
		)
		.bind(sinceIso)
		.all<CountRow>()
	return results ?? []
}

async function readAnalyticsWindow(input: {
	env: FunnelEventEnv & {
		CLOUDFLARE_ACCOUNT_ID?: string
		CLOUDFLARE_API_TOKEN?: string
		CLOUDFLARE_API_BASE_URL?: string
		SENTRY_ENVIRONMENT?: string
	}
	days: number
}): Promise<Array<CountRow> | null> {
	if (!input.env.FUNNEL_EVENTS || input.env.WRANGLER_IS_LOCAL_DEV === 'true') {
		return null
	}
	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) return null
	return queryAnalyticsEngineSql<CountRow>({
		accountId,
		apiToken,
		baseUrl:
			input.env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com',
		query: analyticsQuery(funnelDatasetName(input.env), input.days),
	})
}

export async function loadAdminFunnelSummary(input: {
	env: FunnelEventEnv & {
		CLOUDFLARE_ACCOUNT_ID?: string
		CLOUDFLARE_API_TOKEN?: string
		CLOUDFLARE_API_BASE_URL?: string
		SENTRY_ENVIRONMENT?: string
	}
	now?: Date
}): Promise<AdminFunnelSummary> {
	const now = input.now ?? new Date()
	const since7 = new Date(now.getTime() - 7 * dayMs).toISOString()
	const since28 = new Date(now.getTime() - 28 * dayMs).toISOString()
	try {
		const [analytics7, analytics28] = await Promise.all([
			readAnalyticsWindow({ env: input.env, days: 7 }),
			readAnalyticsWindow({ env: input.env, days: 28 }),
		])
		if (analytics7 && analytics28) {
			return {
				source: 'analytics_engine',
				stages: mergeWindows({ days7: analytics7, days28: analytics28 }),
			}
		}
	} catch (error) {
		console.warn('admin-funnel-analytics-failed', error)
	}
	if (!input.env.APP_DB) {
		return { source: 'unavailable', stages: emptyStages() }
	}
	try {
		const [days7, days28] = await Promise.all([
			readD1Window(input.env.APP_DB, since7),
			readD1Window(input.env.APP_DB, since28),
		])
		return {
			source: 'd1',
			stages: mergeWindows({ days7, days28 }),
		}
	} catch (error) {
		console.warn('admin-funnel-d1-failed', error)
		return { source: 'unavailable', stages: emptyStages() }
	}
}
