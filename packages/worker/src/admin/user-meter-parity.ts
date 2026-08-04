import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import {
	dailyEntitlementResources,
	type DailyEntitlementResource,
	type UserMeterPackageServiceState,
} from '#worker/entitlements/user-meter-do.ts'
import {
	countRunningPackageServicesFromD1,
	packageServiceStateStaleMs,
} from '#worker/entitlements/service.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { isStableUserId, normalizeStableUserId } from '#worker/user-id.ts'

/** Cap paged UserMeter inventory pulls (matches max plan package-service ceiling). */
export const userMeterParityInventoryMaxRows = planLimits.max.maxPackageServices

/** Page size for UserMeter list RPCs (matches DO max export/list page). */
export const userMeterParityPageSize = 500

type DailyResourceRead = {
	resource: DailyEntitlementResource
	meterCount: number | null
	needsBootstrap: boolean
}

type StorageParity = {
	d1Bytes: number
	meterBytes: number | null
	needsBootstrap: boolean
	delta: number | null
	parity: boolean
}

type PackageServiceMismatchCategories = {
	d1Only: number
	meterOnly: number
	statusMismatch: number
	startedAtMismatch: number
	sourceUpdatedAtMismatch: number
}

type PackageServicesParity = {
	d1Count: number
	meterCount: number
	truncated: boolean
	mismatchCategories: PackageServiceMismatchCategories
	running: {
		d1FreshRunningCount: number
		meterRunningCount: number
		parity: boolean
	}
	parity: boolean
}

type DeletionParity = {
	d1DeletingAt: string | null
	meterDeletingAt: string | null
	deletingAtParity: boolean
	/** Active DO write-lease count (meter-only; D1 lease mirror is retired). */
	activeLeaseCount: number
}

export type AdminUserMeterParityReport = {
	generatedAt: string
	stableUserId: string
	/**
	 * Daily counters are UserMeter-only. The D1
	 * `entitlement_daily_counters` mirror was dropped by migration 0126, so
	 * this section reports meter counts without any D1 comparison.
	 */
	daily: {
		day: string
		resources: Array<DailyResourceRead>
	}
	storage: StorageParity
	packageServices: PackageServicesParity
	deletion: DeletionParity
}

type D1PackageServiceStateRow = {
	package_id: string
	service_name: string
	status: string
	started_at: string | null
	updated_at: string
}

function countDeltaParity(input: {
	d1Value: number
	meterValue: number | null
	needsBootstrap: boolean
}): { delta: number | null; parity: boolean } {
	if (input.needsBootstrap || input.meterValue == null) {
		return { delta: null, parity: false }
	}
	const delta = input.d1Value - input.meterValue
	return { delta, parity: delta === 0 }
}

async function userExists(db: D1Database, stableUserId: string) {
	const row = await db
		.prepare(`SELECT 1 AS present FROM users WHERE stable_user_id = ?`)
		.bind(stableUserId)
		.first<{ present: number }>()
	return row != null
}

async function readDailyMeterCounts(input: {
	env: UserMeterEnv
	stableUserId: string
	day: string
	generatedAt: string
}): Promise<AdminUserMeterParityReport['daily']> {
	const meter = userMeterRpc({ env: input.env, userId: input.stableUserId })
	const resources: Array<DailyResourceRead> = []
	for (const resource of dailyEntitlementResources) {
		const meterRead = await meter.read({
			resource,
			day: input.day,
			now: input.generatedAt,
		})
		const needsBootstrap = meterRead.outcome === 'needs_bootstrap'
		resources.push({
			resource,
			meterCount: needsBootstrap ? null : meterRead.count,
			needsBootstrap,
		})
	}
	return { day: input.day, resources }
}

async function readStorageParity(input: {
	db: D1Database
	env: UserMeterEnv
	stableUserId: string
}): Promise<StorageParity> {
	const d1Row = await input.db
		.prepare(
			`SELECT d1_storage_bytes AS bytes
			FROM users
			WHERE stable_user_id = ?`,
		)
		.bind(input.stableUserId)
		.first<{ bytes: number }>()
	const d1Bytes = Math.max(0, Number(d1Row?.bytes ?? 0))
	const meter = userMeterRpc({ env: input.env, userId: input.stableUserId })
	const meterRead = await meter.readStorageBytes()
	const needsBootstrap = meterRead.outcome === 'needs_bootstrap'
	const meterBytes = needsBootstrap ? null : meterRead.bytes
	const { delta, parity } = countDeltaParity({
		d1Value: d1Bytes,
		meterValue: meterBytes,
		needsBootstrap,
	})
	return {
		d1Bytes,
		meterBytes,
		needsBootstrap,
		delta,
		parity,
	}
}

/**
 * Bounded UserMeter list walk. Stops at maxRows, a missing cursor, a
 * repeated/non-advancing cursor, or a zero-item page that still returns a
 * cursor. Stalled/invalid progress marks `truncated` so callers fail closed.
 */
async function collectBoundedUserMeterPages<T>(input: {
	maxRows: number
	fetchPage: (args: {
		pageSize: number
		startAfter: string | null
	}) => Promise<{
		items: ReadonlyArray<T>
		nextStartAfter: string | null
		truncated: boolean
	}>
}): Promise<{ items: Array<T>; truncated: boolean }> {
	const items: Array<T> = []
	let startAfter: string | null = null
	let truncated = false
	for (;;) {
		const remaining = input.maxRows - items.length
		if (remaining <= 0) {
			truncated = true
			break
		}
		const page = await input.fetchPage({
			pageSize: Math.min(userMeterParityPageSize, remaining),
			startAfter,
		})
		items.push(...page.items)
		if (!page.nextStartAfter) {
			truncated = truncated || page.truncated
			break
		}
		if (page.items.length === 0 || page.nextStartAfter === startAfter) {
			truncated = true
			break
		}
		if (items.length >= input.maxRows) {
			truncated = true
			break
		}
		startAfter = page.nextStartAfter
	}
	return { items, truncated }
}

async function listAllMeterPackageServiceStates(input: {
	env: UserMeterEnv
	stableUserId: string
	maxRows: number
}): Promise<{
	states: Array<UserMeterPackageServiceState>
	truncated: boolean
}> {
	const meter = userMeterRpc({ env: input.env, userId: input.stableUserId })
	const { items: states, truncated } = await collectBoundedUserMeterPages({
		maxRows: input.maxRows,
		fetchPage: async ({ pageSize, startAfter }) => {
			const page = await meter.listPackageServiceStates({
				pageSize,
				startAfter,
			})
			return {
				items: page.states,
				nextStartAfter: page.nextStartAfter,
				truncated: page.truncated,
			}
		},
	})
	return { states, truncated }
}

function packageServiceKey(packageId: string, serviceName: string) {
	return `${packageId}\0${serviceName}`
}

function comparePackageServiceStates(input: {
	d1Rows: ReadonlyArray<D1PackageServiceStateRow>
	meterStates: ReadonlyArray<UserMeterPackageServiceState>
}): PackageServiceMismatchCategories {
	const d1ByKey = new Map(
		input.d1Rows.map((row) => [
			packageServiceKey(row.package_id, row.service_name),
			row,
		]),
	)
	const meterByKey = new Map(
		input.meterStates.map((row) => [
			packageServiceKey(row.packageId, row.serviceName),
			row,
		]),
	)
	let d1Only = 0
	let meterOnly = 0
	let statusMismatch = 0
	let startedAtMismatch = 0
	let sourceUpdatedAtMismatch = 0
	for (const [key, d1Row] of d1ByKey) {
		const meterRow = meterByKey.get(key)
		if (!meterRow) {
			d1Only += 1
			continue
		}
		if (d1Row.status !== meterRow.status) statusMismatch += 1
		const d1StartedAt = d1Row.started_at ?? null
		const meterStartedAt = meterRow.startedAt ?? null
		if (d1StartedAt !== meterStartedAt) startedAtMismatch += 1
		if (d1Row.updated_at !== meterRow.sourceUpdatedAt) {
			sourceUpdatedAtMismatch += 1
		}
	}
	for (const key of meterByKey.keys()) {
		if (!d1ByKey.has(key)) meterOnly += 1
	}
	return {
		d1Only,
		meterOnly,
		statusMismatch,
		startedAtMismatch,
		sourceUpdatedAtMismatch,
	}
}

async function readPackageServicesParity(input: {
	db: D1Database
	env: UserMeterEnv
	stableUserId: string
	now: Date
}): Promise<PackageServicesParity> {
	const d1RowsResult = await input.db
		.prepare(
			`SELECT package_id, service_name, status, started_at, updated_at
			FROM package_service_states
			WHERE user_id = ?
			ORDER BY package_id ASC, service_name ASC`,
		)
		.bind(input.stableUserId)
		.all<D1PackageServiceStateRow>()
	const d1Rows = d1RowsResult.results ?? []
	const { states: meterStates, truncated } =
		await listAllMeterPackageServiceStates({
			env: input.env,
			stableUserId: input.stableUserId,
			maxRows: userMeterParityInventoryMaxRows,
		})
	const mismatchCategories = comparePackageServiceStates({
		d1Rows,
		meterStates,
	})
	const d1FreshRunningCount = await countRunningPackageServicesFromD1({
		db: input.db,
		userId: input.stableUserId,
		now: input.now,
	})
	const meter = userMeterRpc({ env: input.env, userId: input.stableUserId })
	const meterRunning = await meter.countRunningPackageServices({
		staleAfterMs: packageServiceStateStaleMs,
		now: input.now.toISOString(),
	})
	const runningParity = d1FreshRunningCount === meterRunning.count
	const inventoryMismatchCount =
		mismatchCategories.d1Only +
		mismatchCategories.meterOnly +
		mismatchCategories.statusMismatch +
		mismatchCategories.startedAtMismatch +
		mismatchCategories.sourceUpdatedAtMismatch
	return {
		d1Count: d1Rows.length,
		meterCount: meterStates.length,
		truncated,
		mismatchCategories,
		running: {
			d1FreshRunningCount,
			meterRunningCount: meterRunning.count,
			parity: runningParity,
		},
		parity: inventoryMismatchCount === 0 && runningParity && !truncated,
	}
}

async function readDeletionParity(input: {
	db: D1Database
	env: UserMeterEnv
	stableUserId: string
}): Promise<DeletionParity> {
	const d1DeletingRow = await input.db
		.prepare(`SELECT deleting_at FROM users WHERE stable_user_id = ?`)
		.bind(input.stableUserId)
		.first<{ deleting_at: string | null }>()
	const d1DeletingAt = d1DeletingRow?.deleting_at ?? null
	const meter = userMeterRpc({ env: input.env, userId: input.stableUserId })
	const meterDeletion = await meter.readDeletionState()
	const deletingAtParity = d1DeletingAt === meterDeletion.deletingAt
	const leaseCount = await meter.countActiveWriteLeases()
	return {
		d1DeletingAt,
		meterDeletingAt: meterDeletion.deletingAt,
		deletingAtParity,
		activeLeaseCount: leaseCount.count,
	}
}

/**
 * Read-only D1 ↔ UserMeter parity report for one account. Never bootstraps or
 * writes parity state. Opening a cold UserMeter stub may still run Durable
 * Object constructor schema maintenance and opportunistic stale daily-counter
 * pruning; cold meter rows surface as `needsBootstrap`.
 */
export async function loadAdminUserMeterParityReport(input: {
	db: D1Database
	env: UserMeterEnv
	stableUserId: string
	now?: Date
}): Promise<AdminUserMeterParityReport | null> {
	const stableUserId = normalizeStableUserId(input.stableUserId)
	if (!isStableUserId(stableUserId)) return null
	if (!(await userExists(input.db, stableUserId))) return null

	const now = input.now ?? new Date()
	const generatedAt = now.toISOString()
	const day = utcDayKey(now)

	const [daily, storage, packageServices, deletion] = await Promise.all([
		readDailyMeterCounts({
			env: input.env,
			stableUserId,
			day,
			generatedAt,
		}),
		readStorageParity({
			db: input.db,
			env: input.env,
			stableUserId,
		}),
		readPackageServicesParity({
			db: input.db,
			env: input.env,
			stableUserId,
			now,
		}),
		readDeletionParity({
			db: input.db,
			env: input.env,
			stableUserId,
		}),
	])

	return {
		generatedAt,
		stableUserId,
		daily,
		storage,
		packageServices,
		deletion,
	}
}
