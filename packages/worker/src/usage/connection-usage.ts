/**
 * Read model for per-connection usage on the Connections page. Reads the
 * hourly `usage_connection_daily` rollup for one org and groups it by the
 * viewer's own credentials, Automation, and (for billing readers) other
 * people.
 */
import { utcDayKey, utcWeekStart } from '@kody-internal/shared/date-keys.ts'
import {
	connectionUsageCountKey,
	connectionUsageEntryId,
	connectionUsageWindowKeys,
	emptyConnectionUsageTotals,
	executeCapCountKey,
	isConnectionUsageEventType,
	type AccountConnectionUsageLoaderData,
	type ConnectionUsageAutomation,
	type ConnectionUsageCaller,
	type ConnectionUsageEntry,
	type ConnectionUsagePerson,
	type ConnectionUsageTotals,
	type ConnectionUsageWindow,
	type ConnectionUsageWindowKey,
} from '#universal/connection-usage.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { connectionUsageRetentionDays } from '#worker/usage/connection-usage-rollup.ts'
import { loadPackageAttributionLabels } from '#worker/usage/credit-attribution.ts'

const utcDayMs = 24 * 60 * 60 * 1000
const labelChunkSize = 50

type ConnectionUsageDbRow = {
	day: string
	credential_kind: string
	holder_user_id: string
	credential_id: string
	package_id: string
	event_type: string
	units: number
	updated_at: string | null
}

export function connectionUsageWindows(
	now: Date,
): Record<ConnectionUsageWindowKey, ConnectionUsageWindow> {
	const today = utcDayKey(now)
	return {
		today: { startDay: today, endDay: today },
		capWeek: { startDay: utcWeekStart(now), endDay: today },
		last7Days: {
			startDay: utcDayKey(new Date(now.getTime() - 6 * utcDayMs)),
			endDay: today,
		},
	}
}

function addUnits(
	totals: ConnectionUsageTotals,
	windows: Record<ConnectionUsageWindowKey, ConnectionUsageWindow>,
	row: ConnectionUsageDbRow,
) {
	if (!isConnectionUsageEventType(row.event_type)) return
	const countKey = connectionUsageCountKey(row.event_type)
	const units = Number(row.units) || 0
	for (const key of connectionUsageWindowKeys) {
		const window = windows[key]
		if (row.day >= window.startDay && row.day <= window.endDay) {
			totals[key][countKey] += units
		}
	}
}

type Group = {
	credentialKind: string
	holderUserId: string
	credentialId: string
	totals: ConnectionUsageTotals
	callers: Map<string, ConnectionUsageTotals>
}

function groupRows(
	rows: ReadonlyArray<ConnectionUsageDbRow>,
	windows: Record<ConnectionUsageWindowKey, ConnectionUsageWindow>,
) {
	const groups = new Map<string, Group>()
	for (const row of rows) {
		const key = `${row.credential_kind}\0${row.holder_user_id}\0${row.credential_id}`
		let group = groups.get(key)
		if (!group) {
			group = {
				credentialKind: row.credential_kind,
				holderUserId: row.holder_user_id,
				credentialId: row.credential_id,
				totals: emptyConnectionUsageTotals(),
				callers: new Map(),
			}
			groups.set(key, group)
		}
		addUnits(group.totals, windows, row)
		const packageId = row.package_id.trim()
		let caller = group.callers.get(packageId)
		if (!caller) {
			caller = emptyConnectionUsageTotals()
			group.callers.set(packageId, caller)
		}
		addUnits(caller, windows, row)
	}
	return [...groups.values()]
}

function mergeTotals(into: ConnectionUsageTotals, from: ConnectionUsageTotals) {
	for (const key of connectionUsageWindowKeys) {
		into[key].executeCalls += from[key].executeCalls
		into[key].workerLoads += from[key].workerLoads
		into[key].runs += from[key].runs
	}
}

/** Heaviest first by the cap unit this week, then by all activity. */
function usageSortValue(totals: ConnectionUsageTotals) {
	const week = totals.capWeek
	return [
		week[executeCapCountKey],
		week.executeCalls + week.workerLoads + week.runs,
		totals.last7Days.executeCalls +
			totals.last7Days.workerLoads +
			totals.last7Days.runs,
	]
}

function compareUsage(a: ConnectionUsageTotals, b: ConnectionUsageTotals) {
	const left = usageSortValue(a)
	const right = usageSortValue(b)
	for (let index = 0; index < left.length; index += 1) {
		const diff = (right[index] ?? 0) - (left[index] ?? 0)
		if (diff !== 0) return diff
	}
	return 0
}

async function loadApiTokenNames(input: {
	db: D1Database
	personId: string
	tokenIds: ReadonlyArray<string>
}) {
	const names = new Map<string, string>()
	for (let index = 0; index < input.tokenIds.length; index += labelChunkSize) {
		const chunk = input.tokenIds.slice(index, index + labelChunkSize)
		const rows = await input.db
			.prepare(
				`SELECT id, name FROM api_tokens
				 WHERE user_id = ? AND id IN (${chunk.map(() => '?').join(', ')})${andLiveDeletedAtSql()}`,
			)
			.bind(input.personId, ...chunk)
			.all<{ id: string; name: string }>()
		for (const row of rows.results ?? []) {
			names.set(row.id, row.name)
		}
	}
	return names
}

async function loadUsernames(input: {
	db: D1Database
	personIds: ReadonlyArray<string>
}) {
	const usernames = new Map<string, string>()
	for (let index = 0; index < input.personIds.length; index += labelChunkSize) {
		const chunk = input.personIds.slice(index, index + labelChunkSize)
		const rows = await input.db
			.prepare(
				`SELECT stable_user_id, username FROM users
				 WHERE stable_user_id IN (${chunk.map(() => '?').join(', ')})${andLiveDeletedAtSql()}`,
			)
			.bind(...chunk)
			.all<{ stable_user_id: string; username: string }>()
		for (const row of rows.results ?? []) {
			usernames.set(row.stable_user_id, row.username)
		}
	}
	return usernames
}

async function loadJobNames(env: Env, orgId: string) {
	try {
		const rows = await jobsData(env).listJobsForUser({ userId: orgId })
		return new Map(rows.map((row) => [row.record.id, row.record.name]))
	} catch (error) {
		console.warn('connection-usage-job-names-failed', error)
		return new Map<string, string>()
	}
}

function automationLabel(
	credentialKind: string,
	credentialId: string,
	jobNames: ReadonlyMap<string, string>,
) {
	switch (credentialKind) {
		case 'schedule':
			return jobNames.get(credentialId) ?? 'Deleted job'
		case 'webhook':
			return 'Webhook'
		case 'inbound-email':
			return 'Inbound email'
		case 'platform-event':
			return 'Event subscription'
		default:
			return 'Automation'
	}
}

/**
 * Per-connection usage for `orgId`. Everyone sees their own credentials
 * (holder = viewer). `includeOrgWide` (billing readers) adds Automation,
 * per-person totals for other people (username only, no connection
 * details), and units recorded before connection tracking.
 *
 * Package names follow the org Repositories list: a package the viewer
 * cannot see (`canSeePackage`) keeps its units but not its name.
 * `packageLinks` is false where packages have no detail page (team orgs).
 */
export async function loadConnectionUsage(input: {
	env: Env
	orgId: string
	orgSlug: string
	viewerPersonId: string
	includeOrgWide: boolean
	canSeePackage: (packageId: string) => boolean
	packageLinks: boolean
	now?: Date
}): Promise<AccountConnectionUsageLoaderData> {
	const now = input.now ?? new Date()
	const windows = connectionUsageWindows(now)
	const startDay = windows.last7Days.startDay
	const db = input.env.APP_DB
	const statement = input.includeOrgWide
		? db
				.prepare(
					`SELECT day, credential_kind, holder_user_id, credential_id,
						package_id, event_type, units, updated_at
					 FROM usage_connection_daily
					 WHERE user_id = ? AND day >= ?`,
				)
				.bind(input.orgId, startDay)
		: db
				.prepare(
					`SELECT day, credential_kind, holder_user_id, credential_id,
						package_id, event_type, units, updated_at
					 FROM usage_connection_daily
					 WHERE user_id = ? AND day >= ? AND holder_user_id = ?`,
				)
				.bind(input.orgId, startDay, input.viewerPersonId)
	const rows = (await statement.all<ConnectionUsageDbRow>()).results ?? []

	let updatedAt: string | null = null
	for (const row of rows) {
		if (row.updated_at && (!updatedAt || row.updated_at > updatedAt)) {
			updatedAt = row.updated_at
		}
	}

	const groups = groupRows(rows, windows)
	const own = groups.filter(
		(group) =>
			group.credentialKind !== '' &&
			group.holderUserId === input.viewerPersonId,
	)
	const automations = input.includeOrgWide
		? groups.filter(
				(group) => group.credentialKind !== '' && group.holderUserId === '',
			)
		: []
	const others = input.includeOrgWide
		? groups.filter(
				(group) =>
					group.credentialKind !== '' &&
					group.holderUserId !== '' &&
					group.holderUserId !== input.viewerPersonId,
			)
		: []

	const packageIds = new Set<string>()
	for (const group of [...own, ...automations]) {
		for (const packageId of group.callers.keys()) {
			if (packageId) packageIds.add(packageId)
		}
	}
	const tokenIds = own
		.filter((group) => group.credentialKind === 'api-token')
		.map((group) => group.credentialId)
		.filter(Boolean)
	const otherPersonIds = [...new Set(others.map((group) => group.holderUserId))]
	const [packageLabels, tokenNames, usernames, jobNames] = await Promise.all([
		loadPackageAttributionLabels({
			db,
			stableUserId: input.orgId,
			username: input.orgSlug,
			packageIds: [...packageIds],
		}),
		loadApiTokenNames({ db, personId: input.viewerPersonId, tokenIds }),
		loadUsernames({ db, personIds: otherPersonIds }),
		automations.some((group) => group.credentialKind === 'schedule')
			? loadJobNames(input.env, input.orgId)
			: Promise.resolve(new Map<string, string>()),
	])

	function callerLabel(packageId: string) {
		if (!packageId) return { label: 'Ad hoc code', href: null }
		const name = packageLabels.names.get(packageId)
		if (name === undefined) return { label: 'Deleted package', href: null }
		if (!input.canSeePackage(packageId)) {
			return { label: 'Package you cannot see', href: null }
		}
		return {
			label: name,
			href: input.packageLinks
				? (packageLabels.hrefs.get(packageId) ?? null)
				: null,
		}
	}

	function callersFor(group: Group): Array<ConnectionUsageCaller> {
		return [...group.callers.entries()]
			.map(([packageId, totals]) => ({
				packageId,
				...callerLabel(packageId),
				totals,
			}))
			.sort((a, b) => compareUsage(a.totals, b.totals))
	}

	const connections: Array<ConnectionUsageEntry> = own
		.map((group) => ({
			id: connectionUsageEntryId(group.credentialKind, group.credentialId),
			credentialKind: group.credentialKind,
			credentialId: group.credentialId,
			label:
				group.credentialKind === 'api-token'
					? (tokenNames.get(group.credentialId) ?? null)
					: null,
			totals: group.totals,
			callers: callersFor(group),
		}))
		.sort((a, b) => compareUsage(a.totals, b.totals))

	const automationEntries: Array<ConnectionUsageAutomation> = automations
		.map((group) => ({
			id: connectionUsageEntryId(group.credentialKind, group.credentialId),
			credentialKind: group.credentialKind,
			credentialId: group.credentialId,
			label: automationLabel(
				group.credentialKind,
				group.credentialId,
				jobNames,
			),
			href:
				group.credentialKind === 'schedule' && jobNames.has(group.credentialId)
					? orgResourcePath(input.orgSlug, 'jobs', group.credentialId)
					: null,
			totals: group.totals,
			callers: callersFor(group),
		}))
		.sort((a, b) => compareUsage(a.totals, b.totals))

	const peopleByHolder = new Map<string, ConnectionUsageTotals>()
	for (const group of others) {
		const totals =
			peopleByHolder.get(group.holderUserId) ?? emptyConnectionUsageTotals()
		mergeTotals(totals, group.totals)
		peopleByHolder.set(group.holderUserId, totals)
	}
	const people: Array<ConnectionUsagePerson> = [...peopleByHolder.entries()]
		.map(([holder, totals]) => ({
			username: usernames.get(holder) ?? null,
			totals,
		}))
		.sort((a, b) => compareUsage(a.totals, b.totals))

	let unattributed: ConnectionUsageTotals | null = null
	if (input.includeOrgWide) {
		unattributed = emptyConnectionUsageTotals()
		for (const group of groups) {
			if (group.credentialKind === '') mergeTotals(unattributed, group.totals)
		}
	}

	return {
		ok: true,
		windows,
		capCountKey: executeCapCountKey,
		retentionDays: connectionUsageRetentionDays,
		updatedAt,
		connections,
		automations: input.includeOrgWide ? automationEntries : null,
		people: input.includeOrgWide ? people : null,
		unattributed,
	}
}
