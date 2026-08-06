import * as Sentry from '@sentry/cloudflare'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { DurableObject } from 'cloudflare:workers'
import {
	type DurableObjectPitrRpc,
	getRecoveryBookmark,
	restoreToBookmark,
} from '#worker/dr/do-pitr.ts'
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
const userMeterSchemaVersion = 9
/** Singleton row id for authoritative storage-byte state (schema v4). */
const storageBytesStateRowId = 1
/** Singleton row id for deletion fence / write leases (schema v6+). */
const deletionStateRowId = 1
/** Staleness window used by the authoritative running-count RPC. */
export const userMeterPackageServiceStateStaleMs = 24 * 60 * 60 * 1000
const defaultExportPageSize = 100
const maxExportPageSize = 500
const maxInboundDeliveryIdLength = 256
const maxPackageServiceIdLength = 256
const maxWriteLeaseTokenLength = 64
const maxWriteLeaseHolderLength = 256
const maxWriteLeaseRepairIdLength = 64
const maxDeletionTimestampLength = 64
const inboundReceiveResource =
	'email_receives_per_day' satisfies DailyEntitlementResource
const utcDayKeyPattern = /^\d{4}-\d{2}-\d{2}$/
/** Matches `new Date().toISOString()` — required for lexicographic monotonicity. */
const packageServiceSourceUpdatedAtPattern =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const packageServiceStatuses = ['running', 'idle', 'stopped', 'error'] as const
export type UserMeterPackageServiceStatus =
	(typeof packageServiceStatuses)[number]
const packageServiceModes = ['bounded', 'persistent'] as const
export type UserMeterPackageServiceMode = (typeof packageServiceModes)[number]

export function isUserMeterPackageServiceStatus(
	status: string,
): status is UserMeterPackageServiceStatus {
	return (packageServiceStatuses as ReadonlyArray<string>).includes(status)
}

/**
 * D1 enumeration-inventory `updated_at` token. Lexicographic order matches
 * revision order, and `r/` sorts after ISO timestamps.
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

/**
 * Result of a revision-guarded absolute reconciliation CAS.
 * `needs_bootstrap` when the singleton is absent; `applied` distinguishes a
 * successful overwrite from a CAS miss caused by a concurrent reserve.
 */
export type UserMeterStorageBytesReconcileResult =
	| UserMeterBootstrapState
	| (UserMeterStorageBytesReadyState & { applied: boolean })

export type UserMeterPackageServiceState = {
	packageId: string
	serviceName: string
	status: UserMeterPackageServiceStatus
	mode: UserMeterPackageServiceMode
	startedAt: string | null
	sourceUpdatedAt: string
	revision: number
	updatedAt: string
	mirrorUpdatedAt: string
}

export type UserMeterPackageServiceUpsertResult = {
	applied: boolean
	created: boolean
	state: UserMeterPackageServiceState
}

export type UserMeterPackageServiceDeleteResult = {
	deleted: boolean
}

export type UserMeterPackageServiceListResult = {
	states: Array<UserMeterPackageServiceState>
	nextStartAfter: string | null
	truncated: boolean
}

export type UserMeterPackageServiceCountResult = {
	count: number
}

export type UserMeterPackageServiceBootstrapResult = {
	applied: number
	skipped: number
}

/** Paged write-lease entry returned by {@link UserMeterRpc.listWriteLeases}. */
export type UserMeterWriteLeaseEntry = {
	token: string
	holder: string
	acquiredAt: string
}

/**
 * Account-export deletion inventory. Omits raw lease token and holder; retains
 * only deleting tombstone presence, active lease count, and acquired_at.
 */
export type UserMeterDeletionStateExport = {
	deletingAt: string | null
	activeWriteLeaseCount: number
	writeLeases: Array<{ acquiredAt: string }>
}

export type UserMeterMarkDeletingResult = {
	deletingAt: string
	created: boolean
	/** Count of active write leases (DO-authority rows) at the time of marking. */
	leaseCount: number
}

export type UserMeterAcquireWriteLeaseResult = {
	acquired: boolean
}

export type UserMeterReleaseWriteLeaseResult = {
	released: boolean
}

export type UserMeterAssertWriteLeaseHeldResult = {
	held: boolean
}

export type UserMeterPrepareWriteLeaseRepairResult =
	| {
			prepared: true
			repairId: string
			token: string
			holder: string
			acquiredAt: string
	  }
	| { prepared: false }

export type UserMeterFinalizeWriteLeaseRepairResult = {
	finalized: boolean
}

export type UserMeterWriteLeaseListResult = {
	leases: Array<UserMeterWriteLeaseEntry>
	nextStartAfter: string | null
	truncated: boolean
}

export type UserMeterWriteLeaseCountResult = {
	count: number
}

export type UserMeterExportResult = {
	counters: Array<UserMeterCounterRow>
	/**
	 * Authoritative storage-byte state. Emitted only on the first export page
	 * (`startAfter` absent); subsequent pages return `null` so paged consumers
	 * never double-count it.
	 */
	storageBytesState: UserMeterStorageBytesState | null
	/**
	 * Authoritative package-service liveness rows. Emitted only on the first
	 * export page (`startAfter` absent); subsequent pages return `null`.
	 */
	packageServiceStates: Array<UserMeterPackageServiceState> | null
	/**
	 * Sanitized deletion-fence / write-lease inventory. Emitted only on the
	 * first export page (`startAfter` absent); subsequent pages return `null`
	 * so paged consumers never double-count. Excludes raw lease token and
	 * holder (see {@link UserMeterDeletionStateExport}).
	 */
	deletionState: UserMeterDeletionStateExport | null
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

type PackageServiceExportCursor = {
	packageId: string
	serviceName: string
}

type WriteLeaseExportCursor = {
	acquiredAt: string
	token: string
}

type PackageServiceSqlRow = {
	package_id: string
	service_name: string
	status: string
	mode: string
	started_at: string | null
	source_updated_at: string
	revision: number
	updated_at: string
}

type WriteLeaseSqlRow = {
	token: string
	holder: string
	acquired_at: string
	pending_repair_id: string | null
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

function assertPackageServiceId(label: string, value: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > maxPackageServiceIdLength
	) {
		throw new Error(
			`UserMeter ${label} must be a non-empty string up to ${maxPackageServiceIdLength} characters.`,
		)
	}
	return value
}

function assertPackageServiceStatus(
	status: string,
): UserMeterPackageServiceStatus {
	if (!isUserMeterPackageServiceStatus(status)) {
		throw new Error(
			`UserMeter package service status must be one of ${packageServiceStatuses.join(', ')}; got ${JSON.stringify(status)}.`,
		)
	}
	return status
}

function assertPackageServiceMode(mode: string): UserMeterPackageServiceMode {
	if (!(packageServiceModes as ReadonlyArray<string>).includes(mode)) {
		throw new Error(
			`UserMeter package service mode must be one of ${packageServiceModes.join(', ')}; got ${JSON.stringify(mode)}.`,
		)
	}
	return mode as UserMeterPackageServiceMode
}

function assertSourceUpdatedAt(sourceUpdatedAt: string): string {
	if (
		typeof sourceUpdatedAt !== 'string' ||
		!packageServiceSourceUpdatedAtPattern.test(sourceUpdatedAt)
	) {
		throw new Error(
			'UserMeter package service sourceUpdatedAt must be an ISO-8601 UTC timestamp.',
		)
	}
	// Pattern-first: avoid Invalid Date → RangeError from toISOString().
	const parsedMs = Date.parse(sourceUpdatedAt)
	if (
		!Number.isFinite(parsedMs) ||
		new Date(parsedMs).toISOString() !== sourceUpdatedAt
	) {
		throw new Error(
			'UserMeter package service sourceUpdatedAt must be an ISO-8601 UTC timestamp.',
		)
	}
	return sourceUpdatedAt
}

function assertDeletionTimestamp(label: string, value: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > maxDeletionTimestampLength
	) {
		throw new Error(
			`UserMeter ${label} must be a non-empty string up to ${maxDeletionTimestampLength} characters.`,
		)
	}
	return value
}

function assertWriteLeaseToken(token: string): string {
	if (
		typeof token !== 'string' ||
		token.length === 0 ||
		token.length > maxWriteLeaseTokenLength
	) {
		throw new Error(
			`UserMeter write lease token must be a non-empty string up to ${maxWriteLeaseTokenLength} characters.`,
		)
	}
	return token
}

function assertWriteLeaseHolder(holder: string): string {
	if (
		typeof holder !== 'string' ||
		holder.length === 0 ||
		holder.length > maxWriteLeaseHolderLength
	) {
		throw new Error(
			`UserMeter write lease holder must be a non-empty string up to ${maxWriteLeaseHolderLength} characters.`,
		)
	}
	return holder
}

function assertWriteLeaseRepairId(repairId: string): string {
	if (
		typeof repairId !== 'string' ||
		repairId.length === 0 ||
		repairId.length > maxWriteLeaseRepairIdLength
	) {
		throw new Error(
			`UserMeter write lease repairId must be a non-empty string up to ${maxWriteLeaseRepairIdLength} characters.`,
		)
	}
	return repairId
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

function encodePackageServiceCursor(cursor: PackageServiceExportCursor) {
	return JSON.stringify([cursor.packageId, cursor.serviceName])
}

function decodePackageServiceCursor(
	startAfter: string,
): PackageServiceExportCursor | null {
	try {
		const parsed = JSON.parse(startAfter) as unknown
		if (!Array.isArray(parsed) || parsed.length !== 2) return null
		const [packageId, serviceName] = parsed
		if (typeof packageId !== 'string' || typeof serviceName !== 'string') {
			return null
		}
		return { packageId, serviceName }
	} catch {
		return null
	}
}

function encodeWriteLeaseCursor(cursor: WriteLeaseExportCursor) {
	return JSON.stringify([cursor.acquiredAt, cursor.token])
}

function decodeWriteLeaseCursor(
	startAfter: string,
): WriteLeaseExportCursor | null {
	try {
		const parsed = JSON.parse(startAfter) as unknown
		if (!Array.isArray(parsed) || parsed.length !== 2) return null
		const [acquiredAt, token] = parsed
		if (typeof acquiredAt !== 'string' || typeof token !== 'string') {
			return null
		}
		return { acquiredAt, token }
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

	async getRecoveryBookmark(input: {
		timestampMs: number
	}): Promise<{ bookmark: string }> {
		return await getRecoveryBookmark(this.ctx, input, {
			environment: this.env,
		})
	}

	async restoreToBookmark(input: {
		bookmark: string
	}): Promise<{ undoBookmark: string }> {
		return await restoreToBookmark(this.ctx, input, {
			objectKind: 'user-meter',
			environment: this.env,
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
		// Authoritative storage-byte state (schema v4).
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS storage_bytes_state (
				id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
				bytes INTEGER NOT NULL,
				revision INTEGER NOT NULL,
				updated_at TEXT NOT NULL
			)
		`)
		// Authoritative package-service liveness state (schema v5; mode at v9).
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS package_service_states (
				package_id TEXT NOT NULL,
				service_name TEXT NOT NULL,
				status TEXT NOT NULL,
				mode TEXT NOT NULL DEFAULT 'persistent',
				started_at TEXT,
				source_updated_at TEXT NOT NULL,
				revision INTEGER NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (package_id, service_name)
			)
		`)
		if (version != null && version < 9) {
			try {
				// Treat warm legacy rows as persistent until the owning service
				// heartbeat records its exact mode. Temporary over-counting is
				// fail-closed for the no-duration-cap concurrency limit.
				this.ctx.storage.sql.exec(
					`ALTER TABLE package_service_states
					ADD COLUMN mode TEXT NOT NULL DEFAULT 'persistent'`,
				)
			} catch {
				// Column already present on a partially migrated object.
			}
		}
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_package_service_states_status_source
			ON package_service_states (status, source_updated_at)`,
		)
		// Deletion fence / write leases (schema v6+; pending_repair_id added at v7).
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS deletion_state (
				id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
				deleting_at TEXT NOT NULL
			)
		`)
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS account_write_leases (
				token TEXT PRIMARY KEY NOT NULL,
				holder TEXT NOT NULL,
				acquired_at TEXT NOT NULL,
				pending_repair_id TEXT
			)
		`)
		if (version != null && version < 7) {
			try {
				this.ctx.storage.sql.exec(
					`ALTER TABLE account_write_leases
					ADD COLUMN pending_repair_id TEXT`,
				)
			} catch {
				// Column already present on a partially migrated object.
			}
		}
		if (version === 7) {
			// Some warm v7 objects retain an ignored `authority` column and
			// index. Rebuild the table so both v7 physical variants converge on
			// the final four-column lease schema without losing active leases.
			this.ctx.storage.transactionSync(() => {
				this.ctx.storage.sql.exec(
					`DROP INDEX IF EXISTS idx_account_write_leases_authority_acquired_token`,
				)
				this.ctx.storage.sql.exec(
					`CREATE TABLE account_write_leases_v8 (
						token TEXT PRIMARY KEY NOT NULL,
						holder TEXT NOT NULL,
						acquired_at TEXT NOT NULL,
						pending_repair_id TEXT
					)`,
				)
				this.ctx.storage.sql.exec(
					`INSERT INTO account_write_leases_v8 (
						token, holder, acquired_at, pending_repair_id
					)
					SELECT token, holder, acquired_at, pending_repair_id
					FROM account_write_leases`,
				)
				this.ctx.storage.sql.exec(`DROP TABLE account_write_leases`)
				this.ctx.storage.sql.exec(
					`ALTER TABLE account_write_leases_v8
					RENAME TO account_write_leases`,
				)
			})
		}
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_account_write_leases_acquired_token
			ON account_write_leases (acquired_at, token)`,
		)
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

	/** Cold-key seed (zero after D1 mirror retirement); INSERT OR IGNORE is concurrency-safe. */
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

	/** Cold initialize authoritative state from a caller-provided physical byte count. */
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

	/** Authoritative storage-byte usage read. */
	async readStorageBytes(): Promise<UserMeterStorageBytesReadResult> {
		const row = this.readStorageRow()
		if (!row) return { outcome: 'needs_bootstrap' }
		return this.storageReadyState(row.bytes, row.revision)
	}

	/**
	 * Authoritative atomic reserve. Missing state returns `needs_bootstrap`.
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
	 * Absolute maintenance set for authoritative storage usage. Materializes
	 * the singleton and bumps its revision.
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

	/**
	 * Revision-guarded absolute reconciliation CAS. Applies `bytes` only when
	 * the current revision equals `expectedRevision`, preventing a scheduled
	 * reconcile sweep from clobbering a live reservation that arrived between
	 * revision capture and the CAS call. Returns `needs_bootstrap` when the
	 * singleton is absent; `applied: false` when another writer changed the
	 * revision first.
	 */
	async reconcileStorageBytes(input: {
		bytes: number
		expectedRevision: number
		updatedAt: string
	}): Promise<UserMeterStorageBytesReconcileResult> {
		const bytes = Math.max(0, Math.trunc(Number(input.bytes) || 0))
		const existing = this.readStorageRow()
		if (!existing) {
			return { outcome: 'needs_bootstrap' }
		}
		if (existing.revision !== input.expectedRevision) {
			// CAS miss: a concurrent reserve or other write changed the revision.
			return {
				...this.storageReadyState(existing.bytes, existing.revision),
				applied: false,
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
			throw new Error('UserMeter reconcileStorageBytes lost storage state.')
		}
		return {
			...this.storageReadyState(row.bytes, row.revision),
			applied: row.revision === nextRevision,
		}
	}

	private packageServiceStateFromRow(
		row: PackageServiceSqlRow,
	): UserMeterPackageServiceState {
		const revision = Math.max(0, Number(row.revision ?? 0))
		const status = assertPackageServiceStatus(String(row.status))
		const mode = assertPackageServiceMode(String(row.mode))
		return {
			packageId: String(row.package_id),
			serviceName: String(row.service_name),
			status,
			mode,
			startedAt:
				status === 'running' && row.started_at != null
					? String(row.started_at)
					: null,
			sourceUpdatedAt: String(row.source_updated_at),
			revision,
			updatedAt: String(row.updated_at),
			mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(revision),
		}
	}

	private readPackageServiceRow(
		packageId: string,
		serviceName: string,
	): UserMeterPackageServiceState | null {
		const row = this.ctx.storage.sql
			.exec<PackageServiceSqlRow>(
				`SELECT package_id, service_name, status, mode, started_at,
					source_updated_at, revision, updated_at
				FROM package_service_states
				WHERE package_id = ? AND service_name = ?`,
				packageId,
				serviceName,
			)
			.toArray()[0]
		if (!row) return null
		return this.packageServiceStateFromRow(row)
	}

	private listAllPackageServiceRows(): Array<UserMeterPackageServiceState> {
		const rows = this.ctx.storage.sql
			.exec<PackageServiceSqlRow>(
				`SELECT package_id, service_name, status, mode, started_at,
					source_updated_at, revision, updated_at
				FROM package_service_states
				ORDER BY package_id ASC, service_name ASC`,
			)
			.toArray()
		return rows.map((row) => this.packageServiceStateFromRow(row))
	}

	/**
	 * D1-first lifecycle projection into authoritative liveness state,
	 * monotonic on `sourceUpdatedAt`. Stale writes are rejected.
	 */
	async upsertPackageServiceState(input: {
		packageId: string
		serviceName: string
		status: string
		mode?: string
		startedAt?: string | null
		sourceUpdatedAt: string
		updatedAt?: string
	}): Promise<UserMeterPackageServiceUpsertResult> {
		const packageId = assertPackageServiceId('packageId', input.packageId)
		const serviceName = assertPackageServiceId('serviceName', input.serviceName)
		const status = assertPackageServiceStatus(input.status)
		// Repair callers and pre-v9 RPC clients omit mode. Counting them as
		// persistent is conservative until a lifecycle heartbeat corrects it.
		const mode = assertPackageServiceMode(input.mode ?? 'persistent')
		const sourceUpdatedAt = assertSourceUpdatedAt(input.sourceUpdatedAt)
		const updatedAt =
			typeof input.updatedAt === 'string' && input.updatedAt.length > 0
				? input.updatedAt
				: sourceUpdatedAt
		const startedAt =
			status === 'running' &&
			typeof input.startedAt === 'string' &&
			input.startedAt.length > 0
				? input.startedAt
				: null

		const existing = this.readPackageServiceRow(packageId, serviceName)
		if (existing && existing.sourceUpdatedAt > sourceUpdatedAt) {
			return {
				applied: false,
				created: false,
				state: existing,
			}
		}
		if (!existing) {
			this.ctx.storage.sql.exec(
				`INSERT INTO package_service_states (
					package_id, service_name, status, mode, started_at,
					source_updated_at, revision, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
				packageId,
				serviceName,
				status,
				mode,
				startedAt,
				sourceUpdatedAt,
				updatedAt,
			)
			const row = this.readPackageServiceRow(packageId, serviceName)
			if (!row) {
				throw new Error(
					'UserMeter upsertPackageServiceState failed to materialize liveness row.',
				)
			}
			return { applied: true, created: true, state: row }
		}

		const nextRevision = existing.revision + 1
		this.ctx.storage.sql.exec(
			`UPDATE package_service_states
			SET status = ?,
				mode = ?,
				started_at = ?,
				source_updated_at = ?,
				revision = ?,
				updated_at = ?
			WHERE package_id = ? AND service_name = ? AND revision = ?`,
			status,
			mode,
			startedAt,
			sourceUpdatedAt,
			nextRevision,
			updatedAt,
			packageId,
			serviceName,
			existing.revision,
		)
		const row = this.readPackageServiceRow(packageId, serviceName)
		if (!row) {
			throw new Error(
				'UserMeter upsertPackageServiceState lost the liveness row.',
			)
		}
		return { applied: true, created: false, state: row }
	}

	/** Delete authoritative liveness state; discovery remains in D1. */
	async deletePackageServiceState(input: {
		packageId: string
		serviceName: string
	}): Promise<UserMeterPackageServiceDeleteResult> {
		const packageId = assertPackageServiceId('packageId', input.packageId)
		const serviceName = assertPackageServiceId('serviceName', input.serviceName)
		const cursor = this.ctx.storage.sql.exec(
			`DELETE FROM package_service_states
			WHERE package_id = ? AND service_name = ?`,
			packageId,
			serviceName,
		)
		return { deleted: cursor.rowsWritten > 0 }
	}

	/** Paged liveness inventory; discovery and account export remain in D1. */
	async listPackageServiceStates(input: {
		pageSize?: number
		startAfter?: string | null
	}): Promise<UserMeterPackageServiceListResult> {
		const pageSize = normalizePageSize(input.pageSize)
		const cursor =
			typeof input.startAfter === 'string' && input.startAfter.length > 0
				? decodePackageServiceCursor(input.startAfter)
				: null
		const rows = (
			cursor
				? this.ctx.storage.sql.exec<PackageServiceSqlRow>(
						`SELECT package_id, service_name, status, mode, started_at,
							source_updated_at, revision, updated_at
						FROM package_service_states
						WHERE package_id > ?
							OR (package_id = ? AND service_name > ?)
						ORDER BY package_id ASC, service_name ASC
						LIMIT ?`,
						cursor.packageId,
						cursor.packageId,
						cursor.serviceName,
						pageSize + 1,
					)
				: this.ctx.storage.sql.exec<PackageServiceSqlRow>(
						`SELECT package_id, service_name, status, mode, started_at,
							source_updated_at, revision, updated_at
						FROM package_service_states
						ORDER BY package_id ASC, service_name ASC
						LIMIT ?`,
						pageSize + 1,
					)
		).toArray()
		const truncated = rows.length > pageSize
		const pageRows = truncated ? rows.slice(0, pageSize) : rows
		const states = pageRows.map((row) => this.packageServiceStateFromRow(row))
		const last = pageRows[pageRows.length - 1]
		return {
			states,
			nextStartAfter:
				truncated && last
					? encodePackageServiceCursor({
							packageId: String(last.package_id),
							serviceName: String(last.service_name),
						})
					: null,
			truncated,
		}
	}

	/** Authoritative running count for service-start enforcement. */
	async countRunningPackageServices(input: {
		staleAfterMs?: number
		excludeService?: { packageId: string; serviceName: string }
		mode?: string
		now?: string
	}): Promise<UserMeterPackageServiceCountResult> {
		const now = input.now ? new Date(input.now) : new Date()
		const safeNow = Number.isNaN(now.valueOf()) ? new Date() : now
		const staleAfterMs =
			typeof input.staleAfterMs === 'number' &&
			Number.isFinite(input.staleAfterMs) &&
			input.staleAfterMs >= 0
				? Math.trunc(input.staleAfterMs)
				: userMeterPackageServiceStateStaleMs
		const freshAfter = new Date(safeNow.valueOf() - staleAfterMs).toISOString()
		const exclusion = input.excludeService
		const packageId = exclusion
			? assertPackageServiceId('packageId', exclusion.packageId)
			: null
		const serviceName = exclusion
			? assertPackageServiceId('serviceName', exclusion.serviceName)
			: null
		const mode =
			input.mode === undefined ? null : assertPackageServiceMode(input.mode)
		const row = (
			packageId && serviceName
				? this.ctx.storage.sql.exec<{ count: number }>(
						`SELECT COUNT(*) AS count
						FROM package_service_states
						WHERE status = 'running'
							AND source_updated_at >= ?
							AND (? IS NULL OR mode = ?)
							AND NOT (package_id = ? AND service_name = ?)`,
						freshAfter,
						mode,
						mode,
						packageId,
						serviceName,
					)
				: this.ctx.storage.sql.exec<{ count: number }>(
						`SELECT COUNT(*) AS count
						FROM package_service_states
						WHERE status = 'running'
							AND source_updated_at >= ?
							AND (? IS NULL OR mode = ?)`,
						freshAfter,
						mode,
						mode,
					)
		).toArray()[0]
		return { count: Math.max(0, Number(row?.count ?? 0)) }
	}

	/** Explicit migration/repair primitive; same monotonic guard as upsert. */
	async bootstrapPackageServiceStates(input: {
		states: ReadonlyArray<{
			packageId: string
			serviceName: string
			status: string
			mode?: string
			startedAt?: string | null
			sourceUpdatedAt: string
			updatedAt?: string
		}>
	}): Promise<UserMeterPackageServiceBootstrapResult> {
		let applied = 0
		let skipped = 0
		for (const state of input.states) {
			const result = await this.upsertPackageServiceState(state)
			if (result.applied) applied += 1
			else skipped += 1
		}
		return { applied, skipped }
	}

	private readDeletingAt(): string | null {
		const row = this.ctx.storage.sql
			.exec<{
				deleting_at: string
			}>(
				`SELECT deleting_at FROM deletion_state WHERE id = ?`,
				deletionStateRowId,
			)
			.toArray()[0]
		if (!row) return null
		const deletingAt = String(row.deleting_at ?? '')
		return deletingAt.length > 0 ? deletingAt : null
	}

	private writeLeaseFromRow(row: WriteLeaseSqlRow): UserMeterWriteLeaseEntry {
		return {
			token: String(row.token),
			holder: String(row.holder),
			acquiredAt: String(row.acquired_at),
		}
	}

	private pendingRepairIdFromRow(row: WriteLeaseSqlRow): string | null {
		const pending = row.pending_repair_id
		return typeof pending === 'string' && pending.length > 0 ? pending : null
	}

	private readWriteLeaseRow(token: string): WriteLeaseSqlRow | null {
		const row = this.ctx.storage.sql
			.exec<WriteLeaseSqlRow>(
				`SELECT token, holder, acquired_at, pending_repair_id
				FROM account_write_leases
				WHERE token = ?`,
				token,
			)
			.toArray()[0]
		return row ?? null
	}

	private readWriteLease(token: string): UserMeterWriteLeaseEntry | null {
		const row = this.readWriteLeaseRow(token)
		if (!row) return null
		return this.writeLeaseFromRow(row)
	}

	private listAllWriteLeaseRows(): Array<UserMeterWriteLeaseEntry> {
		const rows = this.ctx.storage.sql
			.exec<WriteLeaseSqlRow>(
				`SELECT token, holder, acquired_at, pending_repair_id
				FROM account_write_leases
				ORDER BY acquired_at ASC, token ASC`,
			)
			.toArray()
		return rows.map((row) => this.writeLeaseFromRow(row))
	}

	private countWriteLeases(): number {
		const row = this.ctx.storage.sql
			.exec<{
				count: number
			}>(`SELECT COUNT(*) AS count FROM account_write_leases`)
			.toArray()[0]
		return Math.max(0, Number(row?.count ?? 0))
	}

	private insertOrPreserveDeletingAt(deletingAt: string): {
		deletingAt: string
		created: boolean
	} {
		const existing = this.readDeletingAt()
		if (existing != null) {
			return { deletingAt: existing, created: false }
		}
		const cursor = this.ctx.storage.sql.exec(
			`INSERT INTO deletion_state (id, deleting_at)
			VALUES (?, ?)
			ON CONFLICT(id) DO NOTHING`,
			deletionStateRowId,
			deletingAt,
		)
		return {
			deletingAt: this.readDeletingAt() ?? deletingAt,
			created: cursor.rowsWritten > 0,
		}
	}

	private listWriteLeasesPage(input: {
		pageSize?: number
		startAfter?: string | null
	}): UserMeterWriteLeaseListResult {
		const pageSize = normalizePageSize(input.pageSize)
		const cursor =
			typeof input.startAfter === 'string' && input.startAfter.length > 0
				? decodeWriteLeaseCursor(input.startAfter)
				: null
		const rows = (
			cursor
				? this.ctx.storage.sql.exec<WriteLeaseSqlRow>(
						`SELECT token, holder, acquired_at, pending_repair_id
						FROM account_write_leases
						WHERE acquired_at > ?
							OR (acquired_at = ? AND token > ?)
						ORDER BY acquired_at ASC, token ASC
						LIMIT ?`,
						cursor.acquiredAt,
						cursor.acquiredAt,
						cursor.token,
						pageSize + 1,
					)
				: this.ctx.storage.sql.exec<WriteLeaseSqlRow>(
						`SELECT token, holder, acquired_at, pending_repair_id
							FROM account_write_leases
							ORDER BY acquired_at ASC, token ASC
							LIMIT ?`,
						pageSize + 1,
					)
		).toArray()
		const truncated = rows.length > pageSize
		const pageRows = truncated ? rows.slice(0, pageSize) : rows
		const leases = pageRows.map((row) => this.writeLeaseFromRow(row))
		const last = pageRows[pageRows.length - 1]
		return {
			leases,
			nextStartAfter:
				truncated && last
					? encodeWriteLeaseCursor({
							acquiredAt: String(last.acquired_at),
							token: String(last.token),
						})
					: null,
			truncated,
		}
	}

	private readDeletionStateExport(): UserMeterDeletionStateExport {
		const writeLeases = this.listAllWriteLeaseRows().map((lease) => ({
			acquiredAt: lease.acquiredAt,
		}))
		return {
			deletingAt: this.readDeletingAt(),
			activeWriteLeaseCount: writeLeases.length,
			writeLeases,
		}
	}

	/**
	 * Authoritative mark: preserve tombstone, return active DO write-lease count.
	 */
	async markDeleting(input: {
		deletingAt: string
	}): Promise<UserMeterMarkDeletingResult> {
		const deletingAt = assertDeletionTimestamp('deletingAt', input.deletingAt)
		return await this.ctx.blockConcurrencyWhile(async () => {
			const marked = this.insertOrPreserveDeletingAt(deletingAt)
			const leaseCount = this.countWriteLeases()
			return {
				deletingAt: marked.deletingAt,
				created: marked.created,
				leaseCount,
			}
		})
	}

	/** Authoritative lease acquire. */
	async acquireWriteLease(input: {
		token: string
		holder: string
		acquiredAt: string
	}): Promise<UserMeterAcquireWriteLeaseResult> {
		const token = assertWriteLeaseToken(input.token)
		const holder = assertWriteLeaseHolder(input.holder)
		const acquiredAt = assertDeletionTimestamp('acquiredAt', input.acquiredAt)
		const existing = this.readWriteLease(token)
		if (existing) {
			return { acquired: true }
		}
		if (this.readDeletingAt() != null) return { acquired: false }
		const cursor = this.ctx.storage.sql.exec(
			`INSERT INTO account_write_leases (
				token, holder, acquired_at, pending_repair_id
			)
			VALUES (?, ?, ?, NULL)
			ON CONFLICT(token) DO NOTHING`,
			token,
			holder,
			acquiredAt,
		)
		const held = this.readWriteLease(token)
		return {
			acquired: cursor.rowsWritten > 0 || held != null,
		}
	}

	/** Authoritative lease release. */
	async releaseWriteLease(input: {
		token: string
	}): Promise<UserMeterReleaseWriteLeaseResult> {
		const token = assertWriteLeaseToken(input.token)
		const cursor = this.ctx.storage.sql.exec(
			`DELETE FROM account_write_leases WHERE token = ?`,
			token,
		)
		return { released: cursor.rowsWritten > 0 }
	}

	/** Post-write held check; pending repair still counts as held. */
	async assertWriteLeaseHeld(input: {
		token: string
	}): Promise<UserMeterAssertWriteLeaseHeldResult> {
		const token = assertWriteLeaseToken(input.token)
		const lease = this.readWriteLease(token)
		return { held: lease != null }
	}

	/** Prepare audit-safe repair; retries reuse the pending `repairId`. All active rows are treated as authoritative. */
	async prepareWriteLeaseRepair(input: {
		token: string
		expectedAcquiredAt: string
	}): Promise<UserMeterPrepareWriteLeaseRepairResult> {
		const token = assertWriteLeaseToken(input.token)
		const expectedAcquiredAt = assertDeletionTimestamp(
			'expectedAcquiredAt',
			input.expectedAcquiredAt,
		)
		return await this.ctx.blockConcurrencyWhile(async () => {
			const row = this.readWriteLeaseRow(token)
			if (!row) return { prepared: false as const }
			const lease = this.writeLeaseFromRow(row)
			if (lease.acquiredAt !== expectedAcquiredAt) {
				throw new Error(
					'Active account write lease did not match repair request.',
				)
			}
			const existingRepairId = this.pendingRepairIdFromRow(row)
			const repairId = existingRepairId ?? crypto.randomUUID()
			if (!existingRepairId) {
				this.ctx.storage.sql.exec(
					`UPDATE account_write_leases
					SET pending_repair_id = ?
					WHERE token = ? AND acquired_at = ?
						AND (pending_repair_id IS NULL OR pending_repair_id = '')`,
					repairId,
					token,
					expectedAcquiredAt,
				)
			}
			const heldRow = this.readWriteLeaseRow(token)
			if (!heldRow) return { prepared: false as const }
			const held = this.writeLeaseFromRow(heldRow)
			const pending = this.pendingRepairIdFromRow(heldRow)
			if (!pending) {
				throw new Error('Account write lease repair could not be prepared.')
			}
			return {
				prepared: true as const,
				repairId: pending,
				token: held.token,
				holder: held.holder,
				acquiredAt: held.acquiredAt,
			}
		})
	}

	/** Finalize exact pending repair; idempotent when the lease is already gone. */
	async finalizeWriteLeaseRepair(input: {
		token: string
		repairId: string
		expectedAcquiredAt: string
	}): Promise<UserMeterFinalizeWriteLeaseRepairResult> {
		const token = assertWriteLeaseToken(input.token)
		const repairId = assertWriteLeaseRepairId(input.repairId)
		const expectedAcquiredAt = assertDeletionTimestamp(
			'expectedAcquiredAt',
			input.expectedAcquiredAt,
		)
		return await this.ctx.blockConcurrencyWhile(async () => {
			const row = this.readWriteLeaseRow(token)
			if (!row) return { finalized: true }
			const lease = this.writeLeaseFromRow(row)
			if (
				lease.acquiredAt !== expectedAcquiredAt ||
				this.pendingRepairIdFromRow(row) !== repairId
			) {
				throw new Error(
					'Active account write lease did not match repair request.',
				)
			}
			const cursor = this.ctx.storage.sql.exec(
				`DELETE FROM account_write_leases
				WHERE token = ?
					AND acquired_at = ?
					AND pending_repair_id = ?`,
				token,
				expectedAcquiredAt,
				repairId,
			)
			if (cursor.rowsWritten < 1 && this.readWriteLeaseRow(token) != null) {
				throw new Error(
					'Active account write lease did not match repair request.',
				)
			}
			return { finalized: true }
		})
	}

	/** Deletion tombstone read (D1 `deleting_at` remains the permanent gate). */
	async readDeletionState(): Promise<{ deletingAt: string | null }> {
		return { deletingAt: this.readDeletingAt() }
	}

	/** Paged lease list. */
	async listWriteLeases(
		input: {
			pageSize?: number
			startAfter?: string | null
		} = {},
	): Promise<UserMeterWriteLeaseListResult> {
		return this.listWriteLeasesPage(input)
	}

	/** Active lease count (pending repair still counts). */
	async countActiveWriteLeases(): Promise<UserMeterWriteLeaseCountResult> {
		return { count: this.countWriteLeases() }
	}

	async purge(): Promise<{ ok: true }> {
		await this.ctx.blockConcurrencyWhile(async () => {
			const deletingAt = this.readDeletingAt()
			await this.ctx.storage.deleteAll()
			this.initializeSchema()
			if (deletingAt != null) {
				this.ctx.storage.sql.exec(
					`INSERT INTO deletion_state (id, deleting_at)
					VALUES (?, ?)
					ON CONFLICT(id) DO NOTHING`,
					deletionStateRowId,
					deletingAt,
				)
			}
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
		// Singleton and inventory state sits outside counter keyset paging. Emit
		// it once on the first page so totals and consumers never double-count.
		const includeFirstPageState = cursor == null
		const storageRow = includeFirstPageState ? this.readStorageRow() : null
		const packageServiceStates = includeFirstPageState
			? this.listAllPackageServiceRows()
			: null
		const deletionState = includeFirstPageState
			? this.readDeletionStateExport()
			: null
		const last = pageRows[pageRows.length - 1]
		return {
			counters,
			storageBytesState: storageRow
				? {
						bytes: storageRow.bytes,
						revision: storageRow.revision,
						updatedAt: storageRow.updatedAt,
						mirrorUpdatedAt: userMeterMirrorUpdatedAtToken(storageRow.revision),
					}
				: null,
			packageServiceStates,
			deletionState,
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

export type UserMeterRpc = DurableObjectPitrRpc & {
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
	/** Cold initialize authoritative state from a caller-provided physical byte count. */
	initializeStorageBytes: (input: {
		bytes: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesInitializeResult>
	/** Authoritative storage-byte usage read. */
	readStorageBytes: () => Promise<UserMeterStorageBytesReadResult>
	/** Authoritative atomic storage-byte reserve. */
	reserveStorageBytes: (input: {
		requested: number
		limit: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesReserveResult>
	/** Absolute maintenance set; use revision CAS for live reconciliation. */
	setStorageBytes: (input: {
		bytes: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesSetResult>
	/**
	 * Revision-guarded absolute reconciliation CAS. Applies `bytes` only when
	 * current revision equals `expectedRevision`. Returns `needs_bootstrap` if
	 * the singleton is absent; `applied: false` on a CAS miss.
	 */
	reconcileStorageBytes: (input: {
		bytes: number
		expectedRevision: number
		updatedAt: string
	}) => Promise<UserMeterStorageBytesReconcileResult>
	/** Authoritative liveness upsert; monotonic sourceUpdatedAt guard. */
	upsertPackageServiceState: (input: {
		packageId: string
		serviceName: string
		status: string
		mode?: string
		startedAt?: string | null
		sourceUpdatedAt: string
		updatedAt?: string
	}) => Promise<UserMeterPackageServiceUpsertResult>
	/** Authoritative liveness delete on service stop or purge. */
	deletePackageServiceState: (input: {
		packageId: string
		serviceName: string
	}) => Promise<UserMeterPackageServiceDeleteResult>
	/** Paged inventory list. Discovery and account export still use D1. */
	listPackageServiceStates: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterPackageServiceListResult>
	/** Authoritative running count for service-start enforcement. */
	countRunningPackageServices: (input: {
		staleAfterMs?: number
		excludeService?: { packageId: string; serviceName: string }
		mode?: string
		now?: string
	}) => Promise<UserMeterPackageServiceCountResult>
	/**
	 * Explicit repair primitive: bulk-seed from the D1 enumeration inventory
	 * `package_service_states` (all statuses). Uses monotonic `sourceUpdatedAt`
	 * guard so live authoritative rows are never clobbered. Not on the
	 * enforcement path — `countRunningPackageServices` reads the DO directly.
	 */
	bootstrapPackageServiceStates: (input: {
		states: ReadonlyArray<{
			packageId: string
			serviceName: string
			status: string
			mode?: string
			startedAt?: string | null
			sourceUpdatedAt: string
			updatedAt?: string
		}>
	}) => Promise<UserMeterPackageServiceBootstrapResult>
	/** Authoritative deletion mark; preserves tombstone. Returns active write-lease count. */
	markDeleting: (input: {
		deletingAt: string
	}) => Promise<UserMeterMarkDeletingResult>
	/** Authoritative lease acquire. */
	acquireWriteLease: (input: {
		token: string
		holder: string
		acquiredAt: string
	}) => Promise<UserMeterAcquireWriteLeaseResult>
	/** Authoritative lease release. */
	releaseWriteLease: (input: {
		token: string
	}) => Promise<UserMeterReleaseWriteLeaseResult>
	/** Post-write held check; pending repair still counts as held. */
	assertWriteLeaseHeld: (input: {
		token: string
	}) => Promise<UserMeterAssertWriteLeaseHeldResult>
	/** Prepare an audit-safe lease repair; retries reuse repairId. */
	prepareWriteLeaseRepair: (input: {
		token: string
		expectedAcquiredAt: string
	}) => Promise<UserMeterPrepareWriteLeaseRepairResult>
	/** Finalize an exact pending repair by deleting the lease. */
	finalizeWriteLeaseRepair: (input: {
		token: string
		repairId: string
		expectedAcquiredAt: string
	}) => Promise<UserMeterFinalizeWriteLeaseRepairResult>
	/** Deletion tombstone read (D1 deleting_at remains the permanent gate). */
	readDeletionState: () => Promise<{ deletingAt: string | null }>
	/** Paged lease list. */
	listWriteLeases: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterWriteLeaseListResult>
	/** Active lease count (pending repair still counts). */
	countActiveWriteLeases: () => Promise<UserMeterWriteLeaseCountResult>
	purge: () => Promise<{ ok: true }>
	exportCounters: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterExportResult>
}
