import * as Sentry from '@sentry/cloudflare'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { DurableObject } from 'cloudflare:workers'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { type EntitlementResource } from './plans.ts'

/** Daily rate-style resources stored in the per-user UserMeter (UTC day keys). */
export const dailyEntitlementResources = [
	'email_sends_per_day',
	'email_receives_per_day',
	'execute_calls_per_day',
	'outbound_fetches_per_day',
] as const satisfies ReadonlyArray<EntitlementResource>

export type DailyEntitlementResource =
	(typeof dailyEntitlementResources)[number]

export function isDailyEntitlementResource(
	resource: string,
): resource is DailyEntitlementResource {
	return (dailyEntitlementResources as ReadonlyArray<string>).includes(resource)
}

/** Retention window for UserMeter daily rows (enforcement needs today only). */
export const userMeterDailyCounterRetentionDays = 7

const metaSchemaVersionKey = 'schema_version'
/** Bump when initializeSchema DDL changes; warm objects skip DDL. */
const userMeterSchemaVersion = 4
/** Singleton row id for expand-phase D1 storage-byte shadow (schema v4). */
const storageBytesStateRowId = 1

const defaultExportPageSize = 100
const maxExportPageSize = 500
const maxInboundDeliveryIdLength = 256
const inboundReceiveResource =
	'email_receives_per_day' satisfies DailyEntitlementResource
const utcDayKeyPattern = /^\d{4}-\d{2}-\d{2}$/

/**
 * Legacy D1 mirror `updated_at` token. Lexicographic order matches revision
 * order; `r/` sorts after pre-cutover ISO timestamps.
 */
export function userMeterMirrorUpdatedAtToken(revision: number): string {
	const safeRevision =
		Number.isSafeInteger(revision) && revision > 0 ? revision : 0
	return `r/${String(safeRevision).padStart(20, '0')}`
}

export type UserMeterCounterRow = {
	resource: DailyEntitlementResource
	day: string
	count: number
	revision: number
	updatedAt: string
	mirrorUpdatedAt: string
}

export type UserMeterReadyState = {
	outcome: 'ready'
	count: number
	revision: number
	mirrorUpdatedAt: string
}

export type UserMeterBootstrapState = {
	outcome: 'needs_bootstrap'
}

export type UserMeterConsumeResult =
	| UserMeterBootstrapState
	| (UserMeterReadyState & { consumed: boolean })

export type UserMeterReadResult = UserMeterBootstrapState | UserMeterReadyState

export type UserMeterRefundResult = UserMeterReadyState

export type UserMeterInitializeResult = UserMeterReadyState & {
	created: boolean
}

export type UserMeterStorageBytesState = {
	bytes: number
	revision: number
	updatedAt: string
	mirrorUpdatedAt: string
}

export type UserMeterStorageBytesReadyState = {
	outcome: 'ready'
	bytes: number
	revision: number
	mirrorUpdatedAt: string
}

export type UserMeterStorageBytesReadResult =
	| UserMeterBootstrapState
	| UserMeterStorageBytesReadyState

export type UserMeterStorageBytesReserveResult =
	| UserMeterBootstrapState
	| (UserMeterStorageBytesReadyState & { reserved: boolean })

export type UserMeterStorageBytesInitializeResult =
	UserMeterStorageBytesReadyState & {
		created: boolean
	}

export type UserMeterStorageBytesSetResult = UserMeterStorageBytesReadyState & {
	created: boolean
}

export type UserMeterExportResult = {
	counters: Array<UserMeterCounterRow>
	/**
	 * Non-authoritative D1 storage-byte shadow. Emitted only on the first
	 * export page (`startAfter` absent); subsequent pages return `null` so
	 * paged consumers never double-count the singleton shadow.
	 */
	storageBytesShadow: UserMeterStorageBytesState | null
	nextStartAfter: string | null
	truncated: boolean
}

/**
 * Inbound delivery claim + receive consume. Retries set `replayed` without
 * incrementing; `day`/`resource` come from the original claim on cross-day
 * retries.
 */
export type UserMeterInboundDeliveryConsumeResult =
	| UserMeterBootstrapState
	| (UserMeterReadyState & {
			consumed: boolean
			replayed: boolean
			day: string
			resource: typeof inboundReceiveResource
	  })

type ExportCursor = {
	day: string
	resource: string
}

function assertDailyResource(resource: string): DailyEntitlementResource {
	if (!isDailyEntitlementResource(resource)) {
		throw new Error(
			`UserMeter resource must be a daily entitlement resource; got ${JSON.stringify(resource)}.`,
		)
	}
	return resource
}

function assertInboundReceiveResource(
	resource: string,
): typeof inboundReceiveResource {
	const daily = assertDailyResource(resource)
	if (daily !== inboundReceiveResource) {
		throw new Error(
			`UserMeter inbound delivery consume requires ${inboundReceiveResource}; got ${JSON.stringify(resource)}.`,
		)
	}
	return daily
}

function assertUtcDayKey(day: string): string {
	if (!utcDayKeyPattern.test(day)) {
		throw new Error(
			`UserMeter day must be a UTC YYYY-MM-DD key; got ${JSON.stringify(day)}.`,
		)
	}
	return day
}

function assertInboundDeliveryId(deliveryId: string): string {
	if (
		typeof deliveryId !== 'string' ||
		deliveryId.length === 0 ||
		deliveryId.length > maxInboundDeliveryIdLength
	) {
		throw new Error(
			`UserMeter inbound deliveryId must be a non-empty string up to ${maxInboundDeliveryIdLength} characters.`,
		)
	}
	return deliveryId
}

function retentionCutoffDay(now: Date): string {
	const cutoff = new Date(now)
	cutoff.setUTCDate(
		cutoff.getUTCDate() - (userMeterDailyCounterRetentionDays - 1),
	)
	return utcDayKey(cutoff)
}

function encodeExportCursor(cursor: ExportCursor) {
	return JSON.stringify([cursor.day, cursor.resource])
}

function decodeExportCursor(startAfter: string): ExportCursor | null {
	try {
		const parsed = JSON.parse(startAfter) as unknown
		if (!Array.isArray(parsed) || parsed.length !== 2) return null
		const [day, resource] = parsed
		if (typeof day !== 'string' || typeof resource !== 'string') return null
		return { day, resource }
	} catch {
		return null
	}
}

function normalizePageSize(pageSize: number | undefined) {
	const requested =
		typeof pageSize === 'number' && Number.isFinite(pageSize)
			? Math.trunc(pageSize)
			: defaultExportPageSize
	return Math.min(Math.max(requested, 1), maxExportPageSize)
}

function readyState(count: number, revision: number): UserMeterReadyState {
	const safeCount = Math.max(0, count)
	const safeRevision = Math.max(0, revision)
	return {
		outcome: 'ready',
		count: safeCount,
		revision: safeRevision,
		mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(safeRevision),
	}
}

class UserMeterBase extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
		this.ctx.blockConcurrencyWhile(async () => {
			this.initializeSchema()
		})
	}

	private initializeSchema() {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS user_meter_meta (
				key TEXT PRIMARY KEY NOT NULL,
				value INTEGER NOT NULL
			)
		`)
		const versionRow = this.ctx.storage.sql
			.exec<{
				value: number
			}>(
				`SELECT value FROM user_meter_meta WHERE key = ? LIMIT 1`,
				metaSchemaVersionKey,
			)
			.toArray()[0]
		const version = versionRow == null ? null : Number(versionRow.value) || 0
		if (version === userMeterSchemaVersion) return

		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS daily_counters (
				resource TEXT NOT NULL,
				day TEXT NOT NULL,
				count INTEGER NOT NULL,
				revision INTEGER NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (resource, day)
			)
		`)
		if (version === 1) {
			try {
				this.ctx.storage.sql.exec(
					`ALTER TABLE daily_counters ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`,
				)
			} catch {
				// Column already present on a partially migrated object.
			}
		}
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_daily_counters_day
			ON daily_counters (day)`,
		)
		// Per-user delivery-id ledger (PK is delivery_id alone); same retention
		// window as daily counters so Email Routing retries cannot double-charge.
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS inbound_delivery_claims (
				delivery_id TEXT PRIMARY KEY NOT NULL,
				resource TEXT NOT NULL,
				day TEXT NOT NULL,
				count_after INTEGER NOT NULL,
				revision INTEGER NOT NULL,
				claimed_at TEXT NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_inbound_delivery_claims_day
			ON inbound_delivery_claims (day)`,
		)
		// Expand-phase shadow of D1 `users.d1_storage_bytes` (schema v4).
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS storage_bytes_state (
				id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
				bytes INTEGER NOT NULL,
				revision INTEGER NOT NULL,
				updated_at TEXT NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(
			`INSERT INTO user_meter_meta (key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			metaSchemaVersionKey,
			userMeterSchemaVersion,
		)
	}

	private storageReadyState(
		bytes: number,
		revision: number,
	): UserMeterStorageBytesReadyState {
		const safeBytes = Math.max(0, bytes)
		const safeRevision = Math.max(0, revision)
		return {
			outcome: 'ready',
			bytes: safeBytes,
			revision: safeRevision,
			mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(safeRevision),
		}
	}

	private readStorageRow(): {
		bytes: number
		revision: number
		updatedAt: string
	} | null {
		const row = this.ctx.storage.sql
			.exec<{ bytes: number; revision: number; updated_at: string }>(
				`SELECT bytes, revision, updated_at
				FROM storage_bytes_state
				WHERE id = ?`,
				storageBytesStateRowId,
			)
			.toArray()[0]
		if (!row) return null
		return {
			bytes: Math.max(0, Number(row.bytes ?? 0)),
			revision: Math.max(0, Number(row.revision ?? 0)),
			updatedAt: String(row.updated_at ?? ''),
		}
	}

	private deleteStaleCounters(now: Date) {
		const cutoffDay = retentionCutoffDay(now)
		this.ctx.storage.sql.exec(
			`DELETE FROM daily_counters WHERE day < ?`,
			cutoffDay,
		)
		this.ctx.storage.sql.exec(
			`DELETE FROM inbound_delivery_claims WHERE day < ?`,
			cutoffDay,
		)
	}

	private readInboundDeliveryClaim(deliveryId: string): {
		resource: string
		day: string
		countAfter: number
		revision: number
		claimedAt: string
	} | null {
		const row = this.ctx.storage.sql
			.exec<{
				resource: string
				day: string
				count_after: number
				revision: number
				claimed_at: string
			}>(
				`SELECT resource, day, count_after, revision, claimed_at
				FROM inbound_delivery_claims
				WHERE delivery_id = ?`,
				deliveryId,
			)
			.toArray()[0]
		if (!row) return null
		return {
			resource: String(row.resource),
			day: String(row.day),
			countAfter: Math.max(0, Number(row.count_after ?? 0)),
			revision: Math.max(0, Number(row.revision ?? 0)),
			claimedAt: String(row.claimed_at ?? ''),
		}
	}

	private readRow(
		resource: DailyEntitlementResource,
		day: string,
	): { count: number; revision: number; updatedAt: string } | null {
		const row = this.ctx.storage.sql
			.exec<{ count: number; revision: number; updated_at: string }>(
				`SELECT count, revision, updated_at
				FROM daily_counters
				WHERE resource = ? AND day = ?`,
				resource,
				day,
			)
			.toArray()[0]
		if (!row) return null
		return {
			count: Math.max(0, Number(row.count ?? 0)),
			revision: Math.max(0, Number(row.revision ?? 0)),
			updatedAt: String(row.updated_at ?? ''),
		}
	}

	/** Cold-key seed from legacy D1; INSERT OR IGNORE is concurrency-safe. */
	async initialize(input: {
		resource: string
		day: string
		count: number
		updatedAt: string
	}): Promise<UserMeterInitializeResult> {
		const resource = assertDailyResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const now = new Date(input.updatedAt)
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)
		const count = Math.max(0, Math.trunc(Number(input.count) || 0))
		const cursor = this.ctx.storage.sql.exec(
			`INSERT INTO daily_counters (resource, day, count, revision, updated_at)
			VALUES (?, ?, ?, 1, ?)
			ON CONFLICT(resource, day) DO NOTHING`,
			resource,
			day,
			count,
			input.updatedAt,
		)
		const created = cursor.rowsWritten > 0
		const row = this.readRow(resource, day)
		if (!row) {
			throw new Error(
				'UserMeter initialize failed to materialize a counter row.',
			)
		}
		return { ...readyState(row.count, row.revision), created }
	}

	/** Check-and-increment one unit; missing keys return `needs_bootstrap`. */
	async consume(input: {
		resource: string
		day: string
		limit: number
		updatedAt: string
	}): Promise<UserMeterConsumeResult> {
		const resource = assertDailyResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const now = new Date(input.updatedAt)
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)

		const existing = this.readRow(resource, day)
		if (!existing) {
			return { outcome: 'needs_bootstrap' }
		}

		if (input.limit < 1 || existing.count + 1 > input.limit) {
			return {
				...readyState(existing.count, existing.revision),
				consumed: false,
			}
		}

		const nextCount = existing.count + 1
		const nextRevision = existing.revision + 1
		this.ctx.storage.sql.exec(
			`UPDATE daily_counters
			SET count = ?,
				revision = ?,
				updated_at = ?
			WHERE resource = ? AND day = ? AND revision = ?`,
			nextCount,
			nextRevision,
			input.updatedAt,
			resource,
			day,
			existing.revision,
		)
		const row = this.readRow(resource, day)
		if (!row) {
			throw new Error('UserMeter consume lost the counter row.')
		}
		return {
			...readyState(row.count, row.revision),
			consumed: row.count === nextCount && row.revision === nextRevision,
		}
	}

	async read(input: {
		resource: string
		day: string
		now?: string
	}): Promise<UserMeterReadResult> {
		const resource = assertDailyResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const now = input.now ? new Date(input.now) : new Date()
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)
		const row = this.readRow(resource, day)
		if (!row) return { outcome: 'needs_bootstrap' }
		return readyState(row.count, row.revision)
	}

	/**
	 * Claim `deliveryId` and consume one receive unit. Increment + claim insert
	 * run in `storage.transactionSync`.
	 */
	async consumeInboundDelivery(input: {
		deliveryId: string
		resource: string
		day: string
		limit: number
		updatedAt: string
	}): Promise<UserMeterInboundDeliveryConsumeResult> {
		const resource = assertInboundReceiveResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const deliveryId = assertInboundDeliveryId(input.deliveryId)
		const now = new Date(input.updatedAt)
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)

		const priorClaim = this.readInboundDeliveryClaim(deliveryId)
		if (priorClaim) {
			if (priorClaim.resource !== resource) {
				throw new Error(
					`UserMeter inbound deliveryId was claimed for ${JSON.stringify(priorClaim.resource)}; cannot reuse for ${JSON.stringify(resource)}.`,
				)
			}
			const claimedResource = assertInboundReceiveResource(priorClaim.resource)
			const claimedDay = assertUtcDayKey(priorClaim.day)
			const row = this.readRow(claimedResource, claimedDay)
			return {
				...(row
					? readyState(row.count, row.revision)
					: readyState(priorClaim.countAfter, priorClaim.revision)),
				consumed: false,
				replayed: true,
				day: claimedDay,
				resource: claimedResource,
			}
		}

		const existing = this.readRow(resource, day)
		if (!existing) {
			return { outcome: 'needs_bootstrap' }
		}

		if (input.limit < 1 || existing.count + 1 > input.limit) {
			return {
				...readyState(existing.count, existing.revision),
				consumed: false,
				replayed: false,
				day,
				resource,
			}
		}

		const nextCount = existing.count + 1
		const nextRevision = existing.revision + 1
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec(
				`UPDATE daily_counters
				SET count = ?,
					revision = ?,
					updated_at = ?
				WHERE resource = ? AND day = ? AND revision = ?`,
				nextCount,
				nextRevision,
				input.updatedAt,
				resource,
				day,
				existing.revision,
			)
			this.ctx.storage.sql.exec(
				`INSERT INTO inbound_delivery_claims (
					delivery_id, resource, day, count_after, revision, claimed_at
				) VALUES (?, ?, ?, ?, ?, ?)`,
				deliveryId,
				resource,
				day,
				nextCount,
				nextRevision,
				input.updatedAt,
			)
		})
		const row = this.readRow(resource, day)
		if (!row) {
			throw new Error(
				'UserMeter inbound delivery consume lost the counter row.',
			)
		}
		return {
			...readyState(row.count, row.revision),
			consumed: row.count === nextCount && row.revision === nextRevision,
			replayed: false,
			day,
			resource,
		}
	}

	/** Decrement one unit (floors at zero); missing keys stay uninitialized. */
	async refund(input: {
		resource: string
		day: string
		updatedAt: string
	}): Promise<UserMeterRefundResult> {
		const resource = assertDailyResource(input.resource)
		const day = assertUtcDayKey(input.day)
		const now = new Date(input.updatedAt)
		this.deleteStaleCounters(Number.isNaN(now.valueOf()) ? new Date() : now)

		const existing = this.readRow(resource, day)
		if (!existing) {
			return readyState(0, 0)
		}
		const nextCount = Math.max(0, existing.count - 1)
		const nextRevision = existing.revision + 1
		this.ctx.storage.sql.exec(
			`UPDATE daily_counters
			SET count = ?,
				revision = ?,
				updated_at = ?
			WHERE resource = ? AND day = ? AND revision = ?`,
			nextCount,
			nextRevision,
			input.updatedAt,
			resource,
			day,
			existing.revision,
		)
		const row = this.readRow(resource, day)
		if (!row) {
			throw new Error('UserMeter refund lost the counter row.')
		}
		return readyState(row.count, row.revision)
	}

	/** Cutover-support cold seed; expand-phase shadow sync uses {@link setStorageBytes}. */
	async initializeStorageBytes(input: {
		bytes: number
		updatedAt: string
	}): Promise<UserMeterStorageBytesInitializeResult> {
		const bytes = Math.max(0, Math.trunc(Number(input.bytes) || 0))
		const cursor = this.ctx.storage.sql.exec(
			`INSERT INTO storage_bytes_state (id, bytes, revision, updated_at)
			VALUES (?, ?, 1, ?)
			ON CONFLICT(id) DO NOTHING`,
			storageBytesStateRowId,
			bytes,
			input.updatedAt,
		)
		const created = cursor.rowsWritten > 0
		const row = this.readStorageRow()
		if (!row) {
			throw new Error(
				'UserMeter initializeStorageBytes failed to materialize storage state.',
			)
		}
		return { ...this.storageReadyState(row.bytes, row.revision), created }
	}

	/** Cutover-support / shadow read; expand-phase usage and enforcement use D1. */
	async readStorageBytes(): Promise<UserMeterStorageBytesReadResult> {
		const row = this.readStorageRow()
		if (!row) return { outcome: 'needs_bootstrap' }
		return this.storageReadyState(row.bytes, row.revision)
	}

	/**
	 * Cutover-support atomic reserve. Expand-phase enforcement uses D1 only;
	 * missing state returns `needs_bootstrap`.
	 */
	async reserveStorageBytes(input: {
		requested: number
		limit: number
		updatedAt: string
	}): Promise<UserMeterStorageBytesReserveResult> {
		const requested = Math.max(0, Math.trunc(Number(input.requested) || 0))
		const existing = this.readStorageRow()
		if (!existing) {
			return { outcome: 'needs_bootstrap' }
		}
		if (
			requested > 0 &&
			(input.limit < 1 || existing.bytes + requested > input.limit)
		) {
			return {
				...this.storageReadyState(existing.bytes, existing.revision),
				reserved: false,
			}
		}
		if (requested === 0) {
			return {
				...this.storageReadyState(existing.bytes, existing.revision),
				reserved: true,
			}
		}
		const nextBytes = existing.bytes + requested
		const nextRevision = existing.revision + 1
		this.ctx.storage.sql.exec(
			`UPDATE storage_bytes_state
			SET bytes = ?,
				revision = ?,
				updated_at = ?
			WHERE id = ? AND revision = ?`,
			nextBytes,
			nextRevision,
			input.updatedAt,
			storageBytesStateRowId,
			existing.revision,
		)
		const row = this.readStorageRow()
		if (!row) {
			throw new Error('UserMeter reserveStorageBytes lost storage state.')
		}
		return {
			...this.storageReadyState(row.bytes, row.revision),
			reserved: row.bytes === nextBytes && row.revision === nextRevision,
		}
	}

	/**
	 * Absolute shadow-set from D1. Materializes the singleton and bumps
	 * revision. Callers should re-read latest D1 before invoking so delayed
	 * shadows cannot leave the DO behind D1.
	 */
	async setStorageBytes(input: {
		bytes: number
		updatedAt: string
	}): Promise<UserMeterStorageBytesSetResult> {
		const bytes = Math.max(0, Math.trunc(Number(input.bytes) || 0))
		const existing = this.readStorageRow()
		if (!existing) {
			this.ctx.storage.sql.exec(
				`INSERT INTO storage_bytes_state (id, bytes, revision, updated_at)
				VALUES (?, ?, 1, ?)`,
				storageBytesStateRowId,
				bytes,
				input.updatedAt,
			)
			const row = this.readStorageRow()
			if (!row) {
				throw new Error(
					'UserMeter setStorageBytes failed to materialize storage state.',
				)
			}
			return {
				...this.storageReadyState(row.bytes, row.revision),
				created: true,
			}
		}
		const nextRevision = existing.revision + 1
		this.ctx.storage.sql.exec(
			`UPDATE storage_bytes_state
			SET bytes = ?,
				revision = ?,
				updated_at = ?
			WHERE id = ? AND revision = ?`,
			bytes,
			nextRevision,
			input.updatedAt,
			storageBytesStateRowId,
			existing.revision,
		)
		const row = this.readStorageRow()
		if (!row) {
			throw new Error('UserMeter setStorageBytes lost storage state.')
		}
		return {
			...this.storageReadyState(row.bytes, row.revision),
			created: false,
		}
	}

	async purge(): Promise<{ ok: true }> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAll()
			this.initializeSchema()
		})
		return { ok: true }
	}

	async exportCounters(input: {
		pageSize?: number
		startAfter?: string | null
	}): Promise<UserMeterExportResult> {
		this.deleteStaleCounters(new Date())
		const pageSize = normalizePageSize(input.pageSize)
		const cursor =
			typeof input.startAfter === 'string' && input.startAfter.length > 0
				? decodeExportCursor(input.startAfter)
				: null

		const rows = (
			cursor
				? this.ctx.storage.sql.exec<{
						resource: string
						day: string
						count: number
						revision: number
						updated_at: string
					}>(
						`SELECT resource, day, count, revision, updated_at
						FROM daily_counters
						WHERE day > ?
							OR (day = ? AND resource > ?)
						ORDER BY day ASC, resource ASC
						LIMIT ?`,
						cursor.day,
						cursor.day,
						cursor.resource,
						pageSize + 1,
					)
				: this.ctx.storage.sql.exec<{
						resource: string
						day: string
						count: number
						revision: number
						updated_at: string
					}>(
						`SELECT resource, day, count, revision, updated_at
						FROM daily_counters
						ORDER BY day ASC, resource ASC
						LIMIT ?`,
						pageSize + 1,
					)
		).toArray()

		const truncated = rows.length > pageSize
		const pageRows = truncated ? rows.slice(0, pageSize) : rows
		const counters: Array<UserMeterCounterRow> = []
		for (const row of pageRows) {
			const resource = String(row.resource)
			if (!isDailyEntitlementResource(resource)) continue
			const revision = Math.max(0, Number(row.revision ?? 0))
			counters.push({
				resource,
				day: String(row.day),
				count: Math.max(0, Number(row.count ?? 0)),
				revision,
				updatedAt: String(row.updated_at),
				mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(revision),
			})
		}
		// Shadow is a singleton outside keyset paging — emit it once on the
		// first page only so section totals and multi-page consumers do not
		// double-count.
		const includeStorageShadow = cursor == null
		const storageRow = includeStorageShadow ? this.readStorageRow() : null
		const last = pageRows[pageRows.length - 1]
		return {
			counters,
			storageBytesShadow: storageRow
				? {
						bytes: storageRow.bytes,
						revision: storageRow.revision,
						updatedAt: storageRow.updatedAt,
						mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(storageRow.revision),
					}
				: null,
			nextStartAfter:
				truncated && last
					? encodeExportCursor({
							day: String(last.day),
							resource: String(last.resource),
						})
					: null,
			truncated,
		}
	}
}

export const UserMeter = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	UserMeterBase,
)

export type UserMeterRpc = {
	initialize: (input: {
		resource: string
		day: string
		count: number
		updatedAt: string
	}) => Promise<UserMeterInitializeResult>
	consume: (input: {
		resource: string
		day: string
		limit: number
		updatedAt: string
	}) => Promise<UserMeterConsumeResult>
	consumeInboundDelivery: (input: {
		deliveryId: string
		resource: string
		day: string
		limit: number
		updatedAt: string
	}) => Promise<UserMeterInboundDeliveryConsumeResult>
	read: (input: {
		resource: string
		day: string
		now?: string
	}) => Promise<UserMeterReadResult>
	refund: (input: {
		resource: string
		day: string
		updatedAt: string
	}) => Promise<UserMeterRefundResult>
	/** Cutover-support cold seed; expand-phase shadow uses setStorageBytes. */
	initializeStorageBytes: (input: {
		bytes: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesInitializeResult>
	/** Cutover-support / shadow read; expand-phase usage reads D1. */
	readStorageBytes: () => Promise<UserMeterStorageBytesReadResult>
	/** Cutover-support reserve; expand-phase enforcement uses D1. */
	reserveStorageBytes: (input: {
		requested: number
		limit: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesReserveResult>
	/** Expand-phase absolute shadow-set from D1. */
	setStorageBytes: (input: {
		bytes: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesSetResult>
	purge: () => Promise<{ ok: true }>
	exportCounters: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterExportResult>
}
