import { chunkArray } from '@kody-internal/shared/chunk.ts'
import {
	classifyFleetPackageErrorRateConcentrationKind,
	fleetPackageErrorRateFewAccountLimit,
	fleetPackageErrorRateMaxNamedOwners,
	fleetPackageErrorRateMaxNamedPackages,
	isFleetPackageErrorRateConcentrationKind,
	type FleetPackageErrorRateConcentration,
} from '#universal/fleet-package-error-rate-concentration.ts'
import { queryAnalyticsEngineSql } from './aggregate-rollups.ts'
import { fleetPackageErrorRateMetrics } from './fleet-package-error-rate-subscription-event.ts'

const maxSqlBindingsPerChunk = 90

export type FleetPackageErrorRateConcentrationRow = {
	user_id?: string
	entity_id?: string
	error_count?: number | string
}

export type FleetPackageErrorRateConcentrationQueryEnv = {
	APP_DB?: D1Database
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
}

export function buildFleetPackageErrorRateConcentrationQuery(input: {
	dataset: string
	recentStart: Date
	recentEnd: Date
}) {
	const metrics = fleetPackageErrorRateMetrics
		.map((metric) => `'${metric}'`)
		.join(', ')
	return `
SELECT
	blob1 AS user_id,
	blob3 AS entity_id,
	sum(_sample_interval) AS error_count
FROM ${input.dataset}
WHERE timestamp >= toDateTime('${toAnalyticsDateTime(input.recentStart)}')
	AND timestamp < toDateTime('${toAnalyticsDateTime(input.recentEnd)}')
	AND blob2 IN (${metrics})
	AND blob4 = 'error'
GROUP BY user_id, entity_id
ORDER BY error_count DESC
LIMIT 50
FORMAT JSON
`.trim()
}

export function foldFleetPackageErrorRateConcentrationRows(
	rows: ReadonlyArray<FleetPackageErrorRateConcentrationRow>,
) {
	const errorsByOwner = new Map<
		string,
		{ errors: number; entityIds: Map<string, number> }
	>()
	let recentErrors = 0
	const packageIds = new Set<string>()
	for (const row of rows) {
		const ownerId = row.user_id?.trim() ?? ''
		if (ownerId.length === 0) continue
		const errors = Math.max(0, Math.round(Number(row.error_count ?? 0)))
		if (errors <= 0) continue
		recentErrors += errors
		const existing = errorsByOwner.get(ownerId) ?? {
			errors: 0,
			entityIds: new Map<string, number>(),
		}
		existing.errors += errors
		const entityId = row.entity_id?.trim() ?? ''
		if (entityId.length > 0) {
			existing.entityIds.set(
				entityId,
				(existing.entityIds.get(entityId) ?? 0) + errors,
			)
			packageIds.add(entityId)
		}
		errorsByOwner.set(ownerId, existing)
	}
	const ranked = [...errorsByOwner.entries()]
		.map(([ownerId, owner]) => ({
			ownerId,
			errors: owner.errors,
			entityIds: [...owner.entityIds.entries()]
				.sort((left, right) => right[1] - left[1])
				.map(([entityId]) => entityId),
		}))
		.sort((left, right) => right.errors - left.errors)
	const topOwnerShare =
		recentErrors === 0 ? 0 : (ranked[0]?.errors ?? 0) / recentErrors
	const topFewShare =
		recentErrors === 0
			? 0
			: ranked
					.slice(0, fleetPackageErrorRateFewAccountLimit)
					.reduce((sum, owner) => sum + owner.errors, 0) / recentErrors
	return {
		recentErrors,
		ownerCount: ranked.length,
		packageCount: packageIds.size,
		topOwnerShare,
		topFewShare,
		ranked,
	}
}

export async function resolveFleetPackageErrorRateConcentration(input: {
	env: FleetPackageErrorRateConcentrationQueryEnv
	dataset: string
	recentStart: Date
	recentEnd: Date
}): Promise<FleetPackageErrorRateConcentration | null> {
	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!accountId || !apiToken) return null
	const baseUrl =
		input.env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'
	let rows: Array<FleetPackageErrorRateConcentrationRow>
	try {
		rows = await queryAnalyticsEngineSql<FleetPackageErrorRateConcentrationRow>(
			{
				accountId,
				apiToken,
				baseUrl,
				query: buildFleetPackageErrorRateConcentrationQuery({
					dataset: input.dataset,
					recentStart: input.recentStart,
					recentEnd: input.recentEnd,
				}),
			},
		)
	} catch (error) {
		console.warn('fleet-package-error-rate-concentration-query-failed', error)
		return null
	}
	const folded = foldFleetPackageErrorRateConcentrationRows(rows)
	if (folded.recentErrors === 0) return null
	const kind = classifyFleetPackageErrorRateConcentrationKind({
		topOwnerShare: folded.topOwnerShare,
		topFewShare: folded.topFewShare,
	})
	let named: FleetPackageErrorRateConcentration['owners'] = []
	if (kind !== 'fleet') {
		try {
			named = await resolveNamedOwners({
				db: input.env.APP_DB,
				owners: folded.ranked.slice(0, fleetPackageErrorRateMaxNamedOwners),
				recentErrors: folded.recentErrors,
			})
		} catch (error) {
			console.warn('fleet-package-error-rate-concentration-names-failed', error)
		}
	}
	return {
		kind,
		recent_errors: folded.recentErrors,
		owner_count: folded.ownerCount,
		package_count: folded.packageCount,
		top_owner_share: folded.topOwnerShare,
		owners: named,
	}
}

export function parseFleetPackageErrorRateConcentration(
	value: unknown,
): FleetPackageErrorRateConcentration | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (
		typeof record.kind !== 'string' ||
		!isFleetPackageErrorRateConcentrationKind(record.kind) ||
		typeof record.recent_errors !== 'number' ||
		typeof record.owner_count !== 'number' ||
		typeof record.package_count !== 'number' ||
		typeof record.top_owner_share !== 'number' ||
		!Array.isArray(record.owners)
	) {
		return null
	}
	const owners: Array<FleetPackageErrorRateConcentration['owners'][number]> = []
	for (const entry of record.owners) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		const owner = entry as Record<string, unknown>
		if (
			typeof owner.username !== 'string' ||
			owner.username.trim().length === 0 ||
			typeof owner.error_share !== 'number' ||
			!Array.isArray(owner.packages)
		) {
			continue
		}
		const packages: Array<{ kody_id: string }> = []
		for (const pkg of owner.packages) {
			if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) continue
			const row = pkg as Record<string, unknown>
			if (typeof row.kody_id === 'string' && row.kody_id.trim().length > 0) {
				packages.push({ kody_id: row.kody_id.trim() })
			}
		}
		owners.push({
			username: owner.username.trim(),
			error_share: owner.error_share,
			packages,
		})
	}
	return {
		kind: record.kind,
		recent_errors: record.recent_errors,
		owner_count: record.owner_count,
		package_count: record.package_count,
		top_owner_share: record.top_owner_share,
		owners,
	}
}

async function resolveNamedOwners(input: {
	db: D1Database | undefined
	owners: Array<{
		ownerId: string
		errors: number
		entityIds: Array<string>
	}>
	recentErrors: number
}): Promise<FleetPackageErrorRateConcentration['owners']> {
	if (!input.db || input.owners.length === 0) return []
	const usernames = await loadUsernames(
		input.db,
		input.owners.map((owner) => owner.ownerId),
	)
	const packageIds = input.owners.flatMap((owner) => owner.entityIds)
	const packages = await loadPackageKodyIds(input.db, packageIds)
	const named: FleetPackageErrorRateConcentration['owners'] = []
	for (const owner of input.owners) {
		const username = usernames.get(owner.ownerId)
		if (!username) continue
		named.push({
			username,
			error_share: owner.errors / input.recentErrors,
			packages: owner.entityIds
				.map((entityId) => packages.get(entityId))
				.filter((kodyId): kodyId is string => kodyId != null)
				.slice(0, fleetPackageErrorRateMaxNamedPackages)
				.map((kody_id) => ({ kody_id })),
		})
	}
	return named
}

async function loadUsernames(db: D1Database, ownerIds: Array<string>) {
	const usernames = new Map<string, string>()
	for (const chunk of chunkArray(ownerIds, maxSqlBindingsPerChunk)) {
		if (chunk.length === 0) continue
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await db
			.prepare(
				`SELECT stable_user_id, username
				FROM users
				WHERE deleting_at IS NULL
					AND stable_user_id IN (${placeholders})`,
			)
			.bind(...chunk)
			.all<{ stable_user_id: string; username: string }>()
		for (const row of result.results ?? []) {
			const username = row.username.trim()
			if (username.length === 0) continue
			usernames.set(row.stable_user_id, username)
		}
	}
	return usernames
}

async function loadPackageKodyIds(db: D1Database, packageIds: Array<string>) {
	const kodyIds = new Map<string, string>()
	for (const chunk of chunkArray(packageIds, maxSqlBindingsPerChunk)) {
		if (chunk.length === 0) continue
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await db
			.prepare(
				`SELECT id, kody_id
				FROM saved_packages
				WHERE id IN (${placeholders})`,
			)
			.bind(...chunk)
			.all<{ id: string; kody_id: string }>()
		for (const row of result.results ?? []) {
			const kodyId = row.kody_id.trim()
			if (kodyId.length === 0) continue
			kodyIds.set(row.id, kodyId)
		}
	}
	return kodyIds
}

function toAnalyticsDateTime(date: Date) {
	return date.toISOString().slice(0, 19).replace('T', ' ')
}
