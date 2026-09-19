/**
 * Best-effort onboarding funnel points.
 *
 * Production and preview write Workers Analytics Engine dataset
 * `kody_funnel_events` (`FUNNEL_EVENTS`). The same row is inserted into D1
 * `funnel_events` so local admin counts and account deletion work without the
 * Analytics Engine SQL API. Local Wrangler binds an emulated dataset the SQL
 * API cannot read, so that environment writes D1 only — same rule as flag
 * exposures.
 *
 * Writes never throw. `first_*` events claim `funnel_first_claims` and, when
 * a `users` activation column already exists, skip accounts that already
 * passed that gate before this instrumentation shipped.
 */

import {
	isFunnelFirstEventName,
	sanitizeClientFamily,
	sanitizeFunnelErrorClass,
	sanitizeFunnelPlan,
	sanitizeWaitingCardId,
	type FunnelEventName,
	type FunnelFirstEventName,
} from '#universal/funnel-events.ts'

export type FunnelEventEnv = {
	FUNNEL_EVENTS?: AnalyticsEngineDataset
	APP_DB?: D1Database
	WRANGLER_IS_LOCAL_DEV?: string
}

export type FunnelEventInput = {
	event: FunnelEventName
	stableUserId?: string | null
	/** Host label or known client kind. Raw OAuth client ids become `unknown`. */
	clientFamily?: string | null
	errorClass?: string | null
	plan?: string | null
	cardId?: string | null
	timestamp?: string
}

const activationColumnByEvent = {
	first_search: 'first_search_at',
	first_execute: 'first_execute_at',
	first_package: 'first_saved_package_at',
} as const

type ActivationColumn =
	(typeof activationColumnByEvent)[keyof typeof activationColumnByEvent]

const insertEventStatement = `
INSERT INTO funnel_events (
	event, user_id, occurred_at, client_family, error_class, plan, card_id
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
`.trim()

const claimStatement = `
INSERT INTO funnel_first_claims (user_id, event, claimed_at)
VALUES (?1, ?2, ?3)
ON CONFLICT (user_id, event) DO NOTHING
`.trim()

function activationColumn(
	event: FunnelFirstEventName,
): ActivationColumn | null {
	switch (event) {
		case 'first_search':
		case 'first_execute':
		case 'first_package':
			return activationColumnByEvent[event]
		case 'first_secret':
		case 'first_integration':
		case 'first_job':
			return null
		default: {
			const exhaustive: never = event
			return exhaustive
		}
	}
}

export function funnelDatasetName(env: { SENTRY_ENVIRONMENT?: string }) {
	return env.SENTRY_ENVIRONMENT === 'preview'
		? 'kody_funnel_events_preview'
		: 'kody_funnel_events'
}

function writeDataPoint(
	env: FunnelEventEnv,
	input: {
		event: FunnelEventName
		userId: string
		clientFamily: string
		errorClass: string
		plan: string
		cardId: string
	},
) {
	if (!env.FUNNEL_EVENTS || env.WRANGLER_IS_LOCAL_DEV === 'true') return
	env.FUNNEL_EVENTS.writeDataPoint({
		indexes: [input.event],
		blobs: [
			input.event,
			input.userId,
			input.clientFamily,
			input.errorClass,
			input.plan,
			input.cardId,
		],
		doubles: [1],
	})
}

async function activationAlreadySet(
	db: D1Database,
	userId: string,
	column: ActivationColumn,
) {
	const row = await db
		.prepare(
			`SELECT ${column} AS stamped
			 FROM users
			 WHERE stable_user_id = ?
			 LIMIT 1`,
		)
		.bind(userId)
		.first<{ stamped: string | null }>()
	return Boolean(row?.stamped)
}

async function claimFirst(
	db: D1Database,
	userId: string,
	event: FunnelFirstEventName,
	at: string,
) {
	const result = await db.prepare(claimStatement).bind(userId, event, at).run()
	return (result.meta.changes ?? 0) === 1
}

/**
 * Record one funnel point. `first_*` events without a stable user id are
 * dropped. Anonymous `signup_started` is stored with an empty user id.
 */
export async function recordFunnelEvent(
	env: FunnelEventEnv,
	input: FunnelEventInput,
): Promise<void> {
	try {
		const userId = input.stableUserId?.trim() ?? ''
		if (isFunnelFirstEventName(input.event)) {
			if (!userId || !env.APP_DB) return
			const column = activationColumn(input.event)
			if (column && (await activationAlreadySet(env.APP_DB, userId, column))) {
				return
			}
			const at = input.timestamp ?? new Date().toISOString()
			const claimed = await claimFirst(env.APP_DB, userId, input.event, at)
			if (!claimed) return
			await persistFunnelEvent(env, {
				...input,
				timestamp: at,
				stableUserId: userId,
			})
			return
		}
		await persistFunnelEvent(env, { ...input, stableUserId: userId })
	} catch (error) {
		console.debug('funnel-event-record-failed', error)
	}
}

async function persistFunnelEvent(
	env: FunnelEventEnv,
	input: FunnelEventInput & { stableUserId: string },
) {
	const at = input.timestamp ?? new Date().toISOString()
	const clientFamily = sanitizeClientFamily(input.clientFamily)
	const errorClass = sanitizeFunnelErrorClass(input.errorClass)
	const plan = sanitizeFunnelPlan(input.plan)
	const cardId =
		input.event === 'waiting_card_clicked'
			? sanitizeWaitingCardId(input.cardId)
			: ''
	const userId = input.stableUserId
	writeDataPoint(env, {
		event: input.event,
		userId,
		clientFamily,
		errorClass,
		plan,
		cardId,
	})
	if (!env.APP_DB) return
	await env.APP_DB.prepare(insertEventStatement)
		.bind(input.event, userId, at, clientFamily, errorClass, plan, cardId)
		.run()
}
