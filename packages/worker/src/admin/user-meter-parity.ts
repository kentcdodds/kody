import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	userMeterRpc,
	type UserMeterEnv,
} from '#worker/entitlements/user-meter-client.ts'
import {
	dailyEntitlementResources,
	type DailyEntitlementResource,
} from '#worker/entitlements/user-meter-do.ts'
import { calculateUserD1StorageBytes } from '#worker/entitlements/service.ts'
import { isStableUserId, normalizeStableUserId } from '#worker/user-id.ts'

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
	deletion: DeletionParity
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
	// Physical recompute from D1 payload tables — the same source the
	// reconcile lane applies to UserMeter. The retired users.d1_storage_bytes
	// mirror is never read.
	const d1Bytes = Math.max(
		0,
		await calculateUserD1StorageBytes({
			db: input.db,
			userId: input.stableUserId,
		}),
	)
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
 * Read-only UserMeter verification report for one account. Storage compares a
 * physical D1 payload recompute with the meter; deletion compares the permanent
 * D1 tombstone with the meter fence. Never bootstraps or writes parity state.
 * Opening a cold UserMeter stub may still run Durable Object constructor schema
 * maintenance and opportunistic stale daily-counter pruning; cold meter rows
 * surface as `needsBootstrap`.
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

	const [daily, storage, deletion] = await Promise.all([
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
		deletion,
	}
}
