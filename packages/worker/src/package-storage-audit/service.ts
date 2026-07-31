import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { clearPackageOwnedStorageBucket } from '#worker/package-registry/service.ts'
import {
	emptyStorageRunnerEstimatedBytes,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'

export const defaultPackageStorageAuditLimit = 200
export const maxPackageStorageAuditLimit = 500
export const defaultLegacyBucketProbeTimeoutMs = 10_000
const maxConcurrentPackageAuditProbes = 5

export type PackageStorageAuditBucketRow = {
	userId: string
	storageId: string
	lastSeenAt: string
	estimatedBytes: number | null
	probeError: string | null
}

export type PackageStorageAuditReport = {
	ok: true
	legacyBuckets: Array<PackageStorageAuditBucketRow>
	nextStartAfter: string | null
	totals: {
		legacyBuckets: number
		nonEmptyLegacyBuckets: number
		probeErrors: number
		truncated: boolean
	}
}

export type PackageStorageAuditBudgets = {
	legacyBucketProbeMs?: number
}

export type PackageStorageCleanupReport = {
	ok: true
	buckets: Array<{
		userId: string
		storageId: string
		cleared: boolean
	}>
	nextStartAfter: string | null
	totals: {
		cleared: number
		failed: number
		truncated: boolean
	}
}

type PackageStorageAuditCursor = {
	userId: string
	storageId: string
}

type ResolvedBudgets = {
	legacyBucketProbeMs: number
}

export async function buildPackageStorageAuditReport(input: {
	env: Env
	limit: number
	startAfter?: string | null
	budgets?: PackageStorageAuditBudgets
}): Promise<PackageStorageAuditReport> {
	const cursor = parseStartAfterCursor(input.startAfter)
	const budgets = resolveBudgets(input.budgets)
	const bucketPage = await listLegacyBucketsForAudit({
		db: input.env.APP_DB,
		limit: input.limit,
		startAfter: cursor,
	})

	const legacyBuckets: Array<PackageStorageAuditBucketRow> = []
	for (const chunk of chunkArray(
		bucketPage.rows,
		maxConcurrentPackageAuditProbes,
	)) {
		const chunkRows = await Promise.all(
			chunk.map((row) =>
				auditLegacyBucket({
					env: input.env,
					row,
					budgets,
				}),
			),
		)
		legacyBuckets.push(...chunkRows)
	}

	const lastRow = legacyBuckets.at(-1)
	return {
		ok: true,
		legacyBuckets,
		nextStartAfter:
			bucketPage.truncated && lastRow
				? encodeStartAfterCursor({
						userId: lastRow.userId,
						storageId: lastRow.storageId,
					})
				: null,
		totals: {
			legacyBuckets: legacyBuckets.length,
			nonEmptyLegacyBuckets: legacyBuckets.filter(
				(row) =>
					row.estimatedBytes != null &&
					row.estimatedBytes > emptyStorageRunnerEstimatedBytes,
			).length,
			probeErrors: legacyBuckets.filter((row) => row.probeError != null).length,
			truncated: bucketPage.truncated,
		},
	}
}

export async function cleanupLegacyPackageStorageBuckets(input: {
	env: Env
	limit: number
	startAfter?: string | null
}): Promise<PackageStorageCleanupReport> {
	const bucketPage = await listLegacyBucketsForAudit({
		db: input.env.APP_DB,
		limit: input.limit,
		startAfter: parseStartAfterCursor(input.startAfter),
	})
	const buckets: PackageStorageCleanupReport['buckets'] = []
	for (const chunk of chunkArray(
		bucketPage.rows,
		maxConcurrentPackageAuditProbes,
	)) {
		const chunkResults = await Promise.all(
			chunk.map(async (row) => ({
				userId: row.userId,
				storageId: row.storageId,
				cleared: await clearPackageOwnedStorageBucket({
					env: input.env,
					userId: row.userId,
					packageId: row.storageId,
					storageId: row.storageId,
				}),
			})),
		)
		buckets.push(...chunkResults)
	}
	const lastRow = buckets.at(-1)
	return {
		ok: true,
		buckets,
		nextStartAfter:
			bucketPage.truncated && lastRow
				? encodeStartAfterCursor({
						userId: lastRow.userId,
						storageId: lastRow.storageId,
					})
				: null,
		totals: {
			cleared: buckets.filter((row) => row.cleared).length,
			failed: buckets.filter((row) => !row.cleared).length,
			truncated: bucketPage.truncated,
		},
	}
}

function resolveBudgets(
	budgets: PackageStorageAuditBudgets | undefined,
): ResolvedBudgets {
	return {
		legacyBucketProbeMs:
			budgets?.legacyBucketProbeMs ?? defaultLegacyBucketProbeTimeoutMs,
	}
}

function encodeStartAfterCursor(cursor: PackageStorageAuditCursor) {
	return JSON.stringify({
		userId: cursor.userId,
		storageId: cursor.storageId,
	})
}

export class InvalidStartAfterCursorError extends Error {}

function parseStartAfterCursor(
	startAfter: string | null | undefined,
): PackageStorageAuditCursor | null {
	if (startAfter == null) return null
	const trimmed = startAfter.trim()
	if (trimmed.length === 0) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(trimmed)
	} catch {
		throw new InvalidStartAfterCursorError(
			'Invalid startAfter cursor: expected JSON object.',
		)
	}
	if (
		!parsed ||
		typeof parsed !== 'object' ||
		Array.isArray(parsed) ||
		typeof (parsed as { userId?: unknown }).userId !== 'string' ||
		typeof (parsed as { storageId?: unknown }).storageId !== 'string' ||
		(parsed as { userId: string }).userId.length === 0 ||
		(parsed as { storageId: string }).storageId.length === 0
	) {
		throw new InvalidStartAfterCursorError(
			'Invalid startAfter cursor: expected { userId, storageId } strings.',
		)
	}
	return {
		userId: (parsed as { userId: string }).userId,
		storageId: (parsed as { storageId: string }).storageId,
	}
}

async function withDeadline<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(`timed out after ${String(timeoutMs)}ms`))
				}, timeoutMs)
			}),
		])
	} finally {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId)
		}
	}
}

type LegacyBucketInventoryRow = {
	userId: string
	storageId: string
	lastSeenAt: string
}

async function listLegacyBucketsForAudit(input: {
	db: D1Database
	limit: number
	startAfter: PackageStorageAuditCursor | null
}): Promise<{ rows: Array<LegacyBucketInventoryRow>; truncated: boolean }> {
	const result = input.startAfter
		? await input.db
				.prepare(
					`SELECT user_id AS userId, storage_id AS storageId,
						last_seen_at AS lastSeenAt
					FROM user_storage_buckets
					WHERE kind = 'app'
						AND (user_id > ? OR (user_id = ? AND storage_id > ?))
					ORDER BY user_id ASC, storage_id ASC
					LIMIT ?`,
				)
				.bind(
					input.startAfter.userId,
					input.startAfter.userId,
					input.startAfter.storageId,
					input.limit + 1,
				)
				.all<LegacyBucketInventoryRow>()
		: await input.db
				.prepare(
					`SELECT user_id AS userId, storage_id AS storageId,
						last_seen_at AS lastSeenAt
					FROM user_storage_buckets
					WHERE kind = 'app'
					ORDER BY user_id ASC, storage_id ASC
					LIMIT ?`,
				)
				.bind(input.limit + 1)
				.all<LegacyBucketInventoryRow>()
	const rows = result.results ?? []
	const truncated = rows.length > input.limit
	return {
		rows: truncated ? rows.slice(0, input.limit) : rows,
		truncated,
	}
}

async function auditLegacyBucket(input: {
	env: Env
	row: LegacyBucketInventoryRow
	budgets: ResolvedBudgets
}): Promise<PackageStorageAuditBucketRow> {
	const probe = await probeLegacyBucketBytes({
		env: input.env,
		userId: input.row.userId,
		storageId: input.row.storageId,
		timeoutMs: input.budgets.legacyBucketProbeMs,
	})
	return {
		...input.row,
		estimatedBytes: probe.bytes,
		probeError: probe.error,
	}
}

async function probeLegacyBucketBytes(input: {
	env: Env
	userId: string
	storageId: string
	timeoutMs: number
}): Promise<{ bytes: number | null; error: string | null }> {
	try {
		const estimate = await withDeadline(
			storageRunnerRpc({
				env: input.env,
				userId: input.userId,
				storageId: input.storageId,
			}).getEstimatedBytes(),
			input.timeoutMs,
		)
		return { bytes: estimate.estimatedBytes, error: null }
	} catch (error) {
		return { bytes: null, error: getErrorMessage(error) }
	}
}
