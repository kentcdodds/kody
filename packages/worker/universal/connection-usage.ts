/**
 * Per-connection usage: which credential (MCP agent, `kody login` CLI, API
 * token) or Automation each metered unit came through. Written to Analytics
 * Engine `blob12` as `<credential kind>:<holder person id>:<credential id>`
 * and rolled up hourly into D1 `usage_connection_daily`.
 */

/** Usage events rolled up per connection, and the count each one feeds. */
export const connectionUsageEventTypes = [
	'execute',
	'dynamic_worker_day',
	'dynamic_worker_invoke',
] as const

export type ConnectionUsageEventType =
	(typeof connectionUsageEventTypes)[number]

export type ConnectionUsageCountKey = 'executeCalls' | 'workerLoads' | 'runs'

export function connectionUsageCountKey(
	eventType: ConnectionUsageEventType,
): ConnectionUsageCountKey {
	switch (eventType) {
		case 'execute':
			return 'executeCalls'
		case 'dynamic_worker_day':
			return 'workerLoads'
		case 'dynamic_worker_invoke':
			return 'runs'
		default: {
			const exhaustive: never = eventType
			throw new Error(`Unhandled connection usage event: ${String(exhaustive)}`)
		}
	}
}

export function isConnectionUsageEventType(
	value: string,
): value is ConnectionUsageEventType {
	return (connectionUsageEventTypes as ReadonlyArray<string>).includes(value)
}

/**
 * The unit the hosted execute cap counts. Execute calls today; switch to
 * `workerLoads` when the cap moves to unique Dynamic Worker loads.
 */
export const executeCapCountKey: ConnectionUsageCountKey = 'executeCalls'

type ConnectionUsageCounts = Record<ConnectionUsageCountKey, number>

export const connectionUsageWindowKeys = [
	'today',
	'capWeek',
	'last7Days',
] as const

export type ConnectionUsageWindowKey =
	(typeof connectionUsageWindowKeys)[number]

export type ConnectionUsageTotals = Record<
	ConnectionUsageWindowKey,
	ConnectionUsageCounts
>

/** Inclusive UTC day range. */
export type ConnectionUsageWindow = { startDay: string; endDay: string }

type ParsedConnectionKey = {
	credentialKind: string
	holderUserId: string
	credentialId: string
}

/**
 * Split a connection key on its first two `:`. The credential id is last
 * because OAuth client ids are URLs. Empty or malformed keys are
 * unattributed (events recorded before connection tracking).
 */
function parseConnectionKey(key: string): ParsedConnectionKey | null {
	const first = key.indexOf(':')
	if (first <= 0) return null
	const second = key.indexOf(':', first + 1)
	if (second < 0) return null
	return {
		credentialKind: key.slice(0, first),
		holderUserId: key.slice(first + 1, second),
		credentialId: key.slice(second + 1),
	}
}

/** `usage_connection_daily` key columns for a (possibly empty) key. */
export function connectionKeyColumns(key: string | null | undefined) {
	const parsed = parseConnectionKey(key?.trim() ?? '')
	return {
		credential_kind: parsed?.credentialKind ?? '',
		holder_user_id: parsed?.holderUserId ?? '',
		credential_id: parsed?.credentialId ?? '',
	}
}

function emptyConnectionUsageCounts(): ConnectionUsageCounts {
	return { executeCalls: 0, workerLoads: 0, runs: 0 }
}

export function emptyConnectionUsageTotals(): ConnectionUsageTotals {
	return {
		today: emptyConnectionUsageCounts(),
		capWeek: emptyConnectionUsageCounts(),
		last7Days: emptyConnectionUsageCounts(),
	}
}

/** A package (or Ad hoc code) that ran through one connection. */
export type ConnectionUsageCaller = {
	/** Saved package id; empty for Ad hoc execute code. */
	packageId: string
	label: string
	href: string | null
	totals: ConnectionUsageTotals
}

/** One of the viewer's own credentials. */
export type ConnectionUsageEntry = {
	/** `<credential kind>:<credential id>`; stable drill-in key. */
	id: string
	credentialKind: string
	credentialId: string
	/** Server-known label (API token name). Agents are labeled client-side. */
	label: string | null
	totals: ConnectionUsageTotals
	callers: Array<ConnectionUsageCaller>
}

/** Scheduled jobs, webhooks, email, and events: no connection involved. */
export type ConnectionUsageAutomation = {
	id: string
	credentialKind: string
	credentialId: string
	label: string
	href: string | null
	totals: ConnectionUsageTotals
	callers: Array<ConnectionUsageCaller>
}

/** Another person's usage in this org, without their connection details. */
export type ConnectionUsagePerson = {
	username: string | null
	totals: ConnectionUsageTotals
}

export type AccountConnectionUsageLoaderData = {
	ok: true
	windows: Record<ConnectionUsageWindowKey, ConnectionUsageWindow>
	capCountKey: ConnectionUsageCountKey
	retentionDays: number
	/** Latest rollup write; null before any usage was rolled up. */
	updatedAt: string | null
	connections: Array<ConnectionUsageEntry>
	/** Null unless the viewer can read org billing. */
	automations: Array<ConnectionUsageAutomation> | null
	people: Array<ConnectionUsagePerson> | null
	/** Units with no connection key (before tracking started). */
	unattributed: ConnectionUsageTotals | null
}

export function connectionUsageEntryId(
	credentialKind: string,
	credentialId: string,
) {
	return `${credentialKind}:${credentialId}`
}
