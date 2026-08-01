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
const userMeterSchemaVersion = 6
/** Singleton row id for expand-phase D1 storage-byte shadow (schema v4). */
const storageBytesStateRowId = 1
/** Singleton row id for expand-phase D1 deletion-fence shadow (schema v6). */
const deletionStateRowId = 1
/** Matches D1 `packageServiceStateStaleMs` (24h); cutover-support RPC only. */
export const userMeterPackageServiceStateStaleMs = 24 * 60 * 60 * 1000

const defaultExportPageSize = 100
const maxExportPageSize = 500
const maxInboundDeliveryIdLength = 256
const maxPackageServiceIdLength = 256
const maxWriteLeaseTokenLength = 64
const maxWriteLeaseHolderLength = 256
const maxDeletionTimestampLength = 64
const inboundReceiveResource =
	'email_receives_per_day' satisfies DailyEntitlementResource
const utcDayKeyPattern = /^\d{4}-\d{2}-\d{2}$/
/** Matches `new Date().toISOString()` — required for lexicographic monotonicity. */
const packageServiceSourceUpdatedAtPattern =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const packageServiceShadowStatuses = [
	'running',
	'idle',
	'stopped',
	'error',
] as const

export type UserMeterPackageServiceStatus =
	(typeof packageServiceShadowStatuses)[number]

export function isUserMeterPackageServiceStatus(
	status: string,
): status is UserMeterPackageServiceStatus {
	return (packageServiceShadowStatuses as ReadonlyArray<string>).includes(
		status,
	)
}

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

export type UserMeterPackageServiceState = {
	packageId: string
	serviceName: string
	status: UserMeterPackageServiceStatus
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

export type UserMeterWriteLeaseShadow = {
	token: string
	holder: string
	acquiredAt: string
}

/**
 * Internal cutover / list shape. Includes token and holder for parity with D1
 * `account_write_leases`; never emit this from account export.
 */
export type UserMeterDeletionShadow = {
	deletingAt: string | null
	writeLeases: Array<UserMeterWriteLeaseShadow>
}

/**
 * Account-export deletion shadow. Omits raw lease token and holder; retains
 * only deleting tombstone presence, active lease count, and acquired_at.
 */
export type UserMeterDeletionShadowExport = {
	deletingAt: string | null
	activeWriteLeaseCount: number
	writeLeases: Array<{ acquiredAt: string }>
}

export type UserMeterShadowMarkDeletingResult = {
	deletingAt: string
	created: boolean
}

export type UserMeterShadowReplaceDeletionStateResult = {
	deletingAt: string
	created: boolean
	leaseCount: number
}

export type UserMeterShadowAcquireWriteLeaseResult = {
	acquired: boolean
}

export type UserMeterShadowReleaseWriteLeaseResult = {
	released: boolean
}

export type UserMeterWriteLeaseListResult = {
	leases: Array<UserMeterWriteLeaseShadow>
	nextStartAfter: string | null
	truncated: boolean
}

export type UserMeterWriteLeaseCountResult = {
	count: number
}

export type UserMeterDeletionBootstrapResult = {
	deletingAtApplied: boolean
	leasesApplied: number
	leasesSkipped: number
}

export type UserMeterExportResult = {
	counters: Array<UserMeterCounterRow>
	/**
	 * Non-authoritative D1 storage-byte shadow. Emitted only on the first
	 * export page (`startAfter` absent); subsequent pages return `null` so
	 * paged consumers never double-count the singleton shadow.
	 */
	storageBytesShadow: UserMeterStorageBytesState | null
	/**
	 * Non-authoritative D1 `package_service_states` shadow rows. Emitted only
	 * on the first export page (`startAfter` absent); subsequent pages return
	 * `null` so paged consumers never double-count the inventory.
	 */
	packageServiceStatesShadow: Array<UserMeterPackageServiceState> | null
	/**
	 * Non-authoritative D1 deletion-fence / write-lease shadow. Emitted only
	 * on the first export page (`startAfter` absent); subsequent pages return
	 * `null` so paged consumers never double-count the inventory. Sanitized:
	 * excludes raw lease token and holder (see
	 * {@link UserMeterDeletionShadowExport}).
	 */
	deletionShadow: UserMeterDeletionShadowExport | null
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
	started_at: string | null
	source_updated_at: string
	revision: number
	updated_at: string
}

type WriteLeaseSqlRow = {
	token: string
	holder: string
	acquired_at: string
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
			`UserMeter package service status must be one of ${packageServiceShadowStatuses.join(', ')}; got ${JSON.stringify(status)}.`,
		)
	}
	return status
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
		// Expand-phase shadow of D1 `package_service_states` (schema v5).
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS package_service_states (
				package_id TEXT NOT NULL,
				service_name TEXT NOT NULL,
				status TEXT NOT NULL,
				started_at TEXT,
				source_updated_at TEXT NOT NULL,
				revision INTEGER NOT NULL,
				updated_at TEXT NOT NULL,
				PRIMARY KEY (package_id, service_name)
			)
		`)
		this.ctx.storage.sql.exec(
			`CREATE INDEX IF NOT EXISTS idx_package_service_states_status_source
			ON package_service_states (status, source_updated_at)`,
		)
		// Expand-phase shadow of D1 deletion fence / write leases (schema v6).
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
				acquired_at TEXT NOT NULL
			)
		`)
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

	private packageServiceStateFromRow(
		row: PackageServiceSqlRow,
	): UserMeterPackageServiceState {
		const revision = Math.max(0, Number(row.revision ?? 0))
		const status = assertPackageServiceStatus(String(row.status))
		return {
			packageId: String(row.package_id),
			serviceName: String(row.service_name),
			status,
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
				`SELECT package_id, service_name, status, started_at,
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
				`SELECT package_id, service_name, status, started_at,
					source_updated_at, revision, updated_at
				FROM package_service_states
				ORDER BY package_id ASC, service_name ASC`,
			)
			.toArray()
		return rows.map((row) => this.packageServiceStateFromRow(row))
	}

	/**
	 * Expand-phase shadow upsert (monotonic on `sourceUpdatedAt`). Stale writes
	 * are rejected; expand-phase enforcement still reads D1.
	 */
	async upsertPackageServiceState(input: {
		packageId: string
		serviceName: string
		status: string
		startedAt?: string | null
		sourceUpdatedAt: string
		updatedAt?: string
	}): Promise<UserMeterPackageServiceUpsertResult> {
		const packageId = assertPackageServiceId('packageId', input.packageId)
		const serviceName = assertPackageServiceId('serviceName', input.serviceName)
		const status = assertPackageServiceStatus(input.status)
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
					package_id, service_name, status, started_at,
					source_updated_at, revision, updated_at
				) VALUES (?, ?, ?, ?, ?, 1, ?)`,
				packageId,
				serviceName,
				status,
				startedAt,
				sourceUpdatedAt,
				updatedAt,
			)
			const row = this.readPackageServiceRow(packageId, serviceName)
			if (!row) {
				throw new Error(
					'UserMeter upsertPackageServiceState failed to materialize shadow row.',
				)
			}
			return { applied: true, created: true, state: row }
		}

		const nextRevision = existing.revision + 1
		this.ctx.storage.sql.exec(
			`UPDATE package_service_states
			SET status = ?,
				started_at = ?,
				source_updated_at = ?,
				revision = ?,
				updated_at = ?
			WHERE package_id = ? AND service_name = ? AND revision = ?`,
			status,
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
				'UserMeter upsertPackageServiceState lost the shadow row.',
			)
		}
		return { applied: true, created: false, state: row }
	}

	/** Expand-phase shadow delete; discovery still uses D1. */
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

	/** Cutover-support paged shadow list; expand-phase discovery uses D1. */
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
						`SELECT package_id, service_name, status, started_at,
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
						`SELECT package_id, service_name, status, started_at,
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

	/**
	 * Cutover-support running count from the shadow table. Expand-phase
	 * enforcement still uses D1 `countRunningPackageServices`.
	 */
	async countRunningPackageServices(input: {
		staleAfterMs?: number
		excludeService?: { packageId: string; serviceName: string }
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
		const row = (
			packageId && serviceName
				? this.ctx.storage.sql.exec<{ count: number }>(
						`SELECT COUNT(*) AS count
						FROM package_service_states
						WHERE status = 'running'
							AND source_updated_at >= ?
							AND NOT (package_id = ? AND service_name = ?)`,
						freshAfter,
						packageId,
						serviceName,
					)
				: this.ctx.storage.sql.exec<{ count: number }>(
						`SELECT COUNT(*) AS count
						FROM package_service_states
						WHERE status = 'running'
							AND source_updated_at >= ?`,
						freshAfter,
					)
		).toArray()[0]
		return { count: Math.max(0, Number(row?.count ?? 0)) }
	}

	/** Cutover-support bulk seed; same monotonic guard as upsert. */
	async bootstrapPackageServiceStates(input: {
		states: ReadonlyArray<{
			packageId: string
			serviceName: string
			status: string
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

	private writeLeaseFromRow(row: WriteLeaseSqlRow): UserMeterWriteLeaseShadow {
		return {
			token: String(row.token),
			holder: String(row.holder),
			acquiredAt: String(row.acquired_at),
		}
	}

	private readWriteLease(token: string): UserMeterWriteLeaseShadow | null {
		const row = this.ctx.storage.sql
			.exec<WriteLeaseSqlRow>(
				`SELECT token, holder, acquired_at
				FROM account_write_leases
				WHERE token = ?`,
				token,
			)
			.toArray()[0]
		if (!row) return null
		return this.writeLeaseFromRow(row)
	}

	private listAllWriteLeaseRows(): Array<UserMeterWriteLeaseShadow> {
		const rows = this.ctx.storage.sql
			.exec<WriteLeaseSqlRow>(
				`SELECT token, holder, acquired_at
				FROM account_write_leases
				ORDER BY acquired_at ASC, token ASC`,
			)
			.toArray()
		return rows.map((row) => this.writeLeaseFromRow(row))
	}

	private readDeletionShadowExport(): UserMeterDeletionShadowExport {
		const writeLeases = this.listAllWriteLeaseRows().map((lease) => ({
			acquiredAt: lease.acquiredAt,
		}))
		return {
			deletingAt: this.readDeletingAt(),
			activeWriteLeaseCount: writeLeases.length,
			writeLeases,
		}
	}

	/** Expand-phase shadow of D1 `users.deleting_at` (first write wins). */
	async shadowMarkDeleting(input: {
		deletingAt: string
	}): Promise<UserMeterShadowMarkDeletingResult> {
		const deletingAt = assertDeletionTimestamp('deletingAt', input.deletingAt)
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
		const stored = this.readDeletingAt() ?? deletingAt
		return { deletingAt: stored, created: cursor.rowsWritten > 0 }
	}

	/**
	 * Atomically set/preserve the deleting tombstone and replace the shadow
	 * lease set with exactly the supplied active D1 leases. Used by
	 * `markAccountDeleting` so stale unreleased shadow rows cannot linger
	 * after D1 drain (empty lease list clears all shadow leases).
	 */
	async shadowReplaceDeletionState(input: {
		deletingAt: string
		leases?: ReadonlyArray<{
			token: string
			holder: string
			acquiredAt: string
		}>
	}): Promise<UserMeterShadowReplaceDeletionStateResult> {
		const deletingAt = assertDeletionTimestamp('deletingAt', input.deletingAt)
		const leasesByToken = new Map<
			string,
			{ token: string; holder: string; acquiredAt: string }
		>()
		for (const lease of input.leases ?? []) {
			const token = assertWriteLeaseToken(lease.token)
			leasesByToken.set(token, {
				token,
				holder: assertWriteLeaseHolder(lease.holder),
				acquiredAt: assertDeletionTimestamp('acquiredAt', lease.acquiredAt),
			})
		}
		const leases = [...leasesByToken.values()]
		return await this.ctx.blockConcurrencyWhile(async () => {
			const existing = this.readDeletingAt()
			let created = false
			if (existing == null) {
				const cursor = this.ctx.storage.sql.exec(
					`INSERT INTO deletion_state (id, deleting_at)
					VALUES (?, ?)
					ON CONFLICT(id) DO NOTHING`,
					deletionStateRowId,
					deletingAt,
				)
				created = cursor.rowsWritten > 0
			}
			const stored = this.readDeletingAt() ?? deletingAt
			this.ctx.storage.sql.exec(`DELETE FROM account_write_leases`)
			for (const lease of leases) {
				this.ctx.storage.sql.exec(
					`INSERT INTO account_write_leases (token, holder, acquired_at)
					VALUES (?, ?, ?)`,
					lease.token,
					lease.holder,
					lease.acquiredAt,
				)
			}
			return {
				deletingAt: stored,
				created,
				leaseCount: leases.length,
			}
		})
	}

	/** Expand-phase shadow lease acquire; fencing still uses D1. */
	async shadowAcquireWriteLease(input: {
		token: string
		holder: string
		acquiredAt: string
	}): Promise<UserMeterShadowAcquireWriteLeaseResult> {
		const token = assertWriteLeaseToken(input.token)
		const holder = assertWriteLeaseHolder(input.holder)
		const acquiredAt = assertDeletionTimestamp('acquiredAt', input.acquiredAt)
		if (this.readWriteLease(token)) return { acquired: true }
		if (this.readDeletingAt() != null) return { acquired: false }
		const cursor = this.ctx.storage.sql.exec(
			`INSERT INTO account_write_leases (token, holder, acquired_at)
			VALUES (?, ?, ?)
			ON CONFLICT(token) DO NOTHING`,
			token,
			holder,
			acquiredAt,
		)
		return {
			acquired: cursor.rowsWritten > 0 || this.readWriteLease(token) != null,
		}
	}

	/** Expand-phase shadow lease release / repair mirror; fencing uses D1. */
	async shadowReleaseWriteLease(input: {
		token: string
	}): Promise<UserMeterShadowReleaseWriteLeaseResult> {
		const token = assertWriteLeaseToken(input.token)
		const cursor = this.ctx.storage.sql.exec(
			`DELETE FROM account_write_leases WHERE token = ?`,
			token,
		)
		return { released: cursor.rowsWritten > 0 }
	}

	/** Cutover-support deletion tombstone read; Phase A uses D1. */
	async readDeletionState(): Promise<{ deletingAt: string | null }> {
		return { deletingAt: this.readDeletingAt() }
	}

	/** Cutover-support paged shadow lease list; Phase A list uses D1. */
	async listWriteLeases(
		input: {
			pageSize?: number
			startAfter?: string | null
		} = {},
	): Promise<UserMeterWriteLeaseListResult> {
		const pageSize = normalizePageSize(input.pageSize)
		const cursor =
			typeof input.startAfter === 'string' && input.startAfter.length > 0
				? decodeWriteLeaseCursor(input.startAfter)
				: null
		const rows = (
			cursor
				? this.ctx.storage.sql.exec<WriteLeaseSqlRow>(
						`SELECT token, holder, acquired_at
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
						`SELECT token, holder, acquired_at
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

	/** Cutover-support active lease count; Phase A drain uses D1. */
	async countActiveWriteLeases(): Promise<UserMeterWriteLeaseCountResult> {
		const row = this.ctx.storage.sql
			.exec<{
				count: number
			}>(`SELECT COUNT(*) AS count FROM account_write_leases`)
			.toArray()[0]
		return { count: Math.max(0, Number(row?.count ?? 0)) }
	}

	/**
	 * Cutover-support cold seed. Leases apply first (same guards as
	 * {@link shadowAcquireWriteLease}), then the deleting tombstone.
	 */
	async bootstrapDeletionState(input: {
		deletingAt?: string | null
		leases?: ReadonlyArray<{
			token: string
			holder: string
			acquiredAt: string
		}>
	}): Promise<UserMeterDeletionBootstrapResult> {
		let leasesApplied = 0
		let leasesSkipped = 0
		for (const lease of input.leases ?? []) {
			const token = assertWriteLeaseToken(lease.token)
			if (this.readWriteLease(token)) {
				leasesSkipped += 1
				continue
			}
			const result = await this.shadowAcquireWriteLease(lease)
			if (result.acquired) leasesApplied += 1
			else leasesSkipped += 1
		}
		let deletingAtApplied = false
		if (typeof input.deletingAt === 'string' && input.deletingAt.length > 0) {
			const marked = await this.shadowMarkDeleting({
				deletingAt: input.deletingAt,
			})
			deletingAtApplied = marked.created
		}
		return { deletingAtApplied, leasesApplied, leasesSkipped }
	}

	async purge(): Promise<{ ok: true }> {
		await this.ctx.blockConcurrencyWhile(async () => {
			// Preserve deleting tombstone across deleteAll for later cutover safety.
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
		// Shadow inventories sit outside counter keyset paging — emit them once
		// on the first page only so section totals and multi-page consumers do
		// not double-count.
		const includeShadows = cursor == null
		const storageRow = includeShadows ? this.readStorageRow() : null
		const packageServiceStatesShadow = includeShadows
			? this.listAllPackageServiceRows()
			: null
		const deletionShadow = includeShadows
			? this.readDeletionShadowExport()
			: null
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
			packageServiceStatesShadow,
			deletionShadow,
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
	/** Expand-phase shadow upsert; not used for enforcement. */
	upsertPackageServiceState: (input: {
		packageId: string
		serviceName: string
		status: string
		startedAt?: string | null
		sourceUpdatedAt: string
		updatedAt?: string
	}) => Promise<UserMeterPackageServiceUpsertResult>
	/** Expand-phase shadow delete. */
	deletePackageServiceState: (input: {
		packageId: string
		serviceName: string
	}) => Promise<UserMeterPackageServiceDeleteResult>
	/** Cutover-support paged shadow list; discovery uses D1. */
	listPackageServiceStates: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterPackageServiceListResult>
	/** Cutover-support running count; service-start still uses D1. */
	countRunningPackageServices: (input: {
		staleAfterMs?: number
		excludeService?: { packageId: string; serviceName: string }
		now?: string
	}) => Promise<UserMeterPackageServiceCountResult>
	/** Cutover-support bulk seed with sourceUpdatedAt monotonic guards. */
	bootstrapPackageServiceStates: (input: {
		states: ReadonlyArray<{
			packageId: string
			serviceName: string
			status: string
			startedAt?: string | null
			sourceUpdatedAt: string
			updatedAt?: string
		}>
	}) => Promise<UserMeterPackageServiceBootstrapResult>
	/** Expand-phase shadow of D1 users.deleting_at; fence still uses D1. */
	shadowMarkDeleting: (input: {
		deletingAt: string
	}) => Promise<UserMeterShadowMarkDeletingResult>
	/**
	 * Atomically set/preserve deleting tombstone and replace shadow leases
	 * with the supplied active D1 set (empty clears stale shadows).
	 */
	shadowReplaceDeletionState: (input: {
		deletingAt: string
		leases?: ReadonlyArray<{
			token: string
			holder: string
			acquiredAt: string
		}>
	}) => Promise<UserMeterShadowReplaceDeletionStateResult>
	/** Expand-phase shadow lease acquire; fencing still uses D1. */
	shadowAcquireWriteLease: (input: {
		token: string
		holder: string
		acquiredAt: string
	}) => Promise<UserMeterShadowAcquireWriteLeaseResult>
	/** Expand-phase shadow lease release / repair mirror; fencing uses D1. */
	shadowReleaseWriteLease: (input: {
		token: string
	}) => Promise<UserMeterShadowReleaseWriteLeaseResult>
	/** Cutover-support deletion tombstone read; Phase A uses D1. */
	readDeletionState: () => Promise<{ deletingAt: string | null }>
	/** Cutover-support paged shadow lease list; Phase A list uses D1. */
	listWriteLeases: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterWriteLeaseListResult>
	/** Cutover-support active lease count; Phase A drain uses D1. */
	countActiveWriteLeases: () => Promise<UserMeterWriteLeaseCountResult>
	/** Cutover-support cold seed with monotonic mark / acquire guards. */
	bootstrapDeletionState: (input: {
		deletingAt?: string | null
		leases?: ReadonlyArray<{
			token: string
			holder: string
			acquiredAt: string
		}>
	}) => Promise<UserMeterDeletionBootstrapResult>
	purge: () => Promise<{ ok: true }>
	exportCounters: (input: {
		pageSize?: number
		startAfter?: string | null
	}) => Promise<UserMeterExportResult>
}
