import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { collectAmbientStorageImportFiles } from '#worker/repo/checks.ts'
import {
	emptyStorageRunnerEstimatedBytes,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'

export const defaultPackageStorageAuditLimit = 200
export const maxPackageStorageAuditLimit = 500
export const defaultLegacyBucketProbeTimeoutMs = 10_000
export const defaultSourceScanTimeoutMs = 20_000
const maxOrphanAppBuckets = 500
const maxConcurrentPackageAuditProbes = 5

export type PackageStorageAuditPackageRow = {
	userId: string
	packageId: string
	kodyId: string
	legacyBucketBytes: number | null
	legacyBucketProbeError: string | null
	ambientStorageImportFiles: Array<string>
	sourceScanError: string | null
}

export type PackageStorageAuditOrphanBucket = {
	userId: string
	storageId: string
	lastSeenAt: string
}

export type PackageStorageAuditReport = {
	ok: true
	packages: Array<PackageStorageAuditPackageRow>
	orphanAppBuckets: Array<PackageStorageAuditOrphanBucket>
	nextStartAfter: string | null
	totals: {
		appPackages: number
		nonEmptyLegacyBuckets: number
		packagesWithAmbientImports: number
		orphanAppBuckets: number
		truncated: boolean
		orphanTruncated: boolean
	}
}

export type PackageStorageAuditBudgets = {
	legacyBucketProbeMs?: number
	sourceScanMs?: number
}

type AppPackageRow = {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
}

type PackageStorageAuditCursor = {
	userId: string
	packageId: string
}

type ResolvedBudgets = {
	legacyBucketProbeMs: number
	sourceScanMs: number
}

export async function buildPackageStorageAuditReport(input: {
	env: Env
	baseUrl: string
	limit: number
	startAfter?: string | null
	budgets?: PackageStorageAuditBudgets
}): Promise<PackageStorageAuditReport> {
	const cursor = parseStartAfterCursor(input.startAfter)
	const budgets = resolveBudgets(input.budgets)
	const [appPackagePage, orphanPage] = await Promise.all([
		listAppPackagesForAudit({
			db: input.env.APP_DB,
			limit: input.limit,
			startAfter: cursor,
		}),
		listOrphanAppBuckets({ db: input.env.APP_DB }),
	])

	const packages: Array<PackageStorageAuditPackageRow> = []
	for (const chunk of chunkArray(
		appPackagePage.rows,
		maxConcurrentPackageAuditProbes,
	)) {
		const chunkRows = await Promise.all(
			chunk.map((row) =>
				auditAppPackage({
					env: input.env,
					baseUrl: input.baseUrl,
					row,
					budgets,
				}),
			),
		)
		packages.push(...chunkRows)
	}

	const lastRow = packages.at(-1)
	return {
		ok: true,
		packages,
		orphanAppBuckets: orphanPage.rows,
		nextStartAfter:
			appPackagePage.truncated && lastRow
				? encodeStartAfterCursor({
						userId: lastRow.userId,
						packageId: lastRow.packageId,
					})
				: null,
		totals: {
			appPackages: packages.length,
			nonEmptyLegacyBuckets: packages.filter(
				(row) =>
					row.legacyBucketBytes != null &&
					row.legacyBucketBytes > emptyStorageRunnerEstimatedBytes,
			).length,
			packagesWithAmbientImports: packages.filter(
				(row) => row.ambientStorageImportFiles.length > 0,
			).length,
			orphanAppBuckets: orphanPage.rows.length,
			truncated: appPackagePage.truncated,
			orphanTruncated: orphanPage.truncated,
		},
	}
}

function resolveBudgets(
	budgets: PackageStorageAuditBudgets | undefined,
): ResolvedBudgets {
	return {
		legacyBucketProbeMs:
			budgets?.legacyBucketProbeMs ?? defaultLegacyBucketProbeTimeoutMs,
		sourceScanMs: budgets?.sourceScanMs ?? defaultSourceScanTimeoutMs,
	}
}

function encodeStartAfterCursor(cursor: PackageStorageAuditCursor) {
	return JSON.stringify({
		userId: cursor.userId,
		packageId: cursor.packageId,
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
		typeof (parsed as { packageId?: unknown }).packageId !== 'string' ||
		(parsed as { userId: string }).userId.length === 0 ||
		(parsed as { packageId: string }).packageId.length === 0
	) {
		throw new InvalidStartAfterCursorError(
			'Invalid startAfter cursor: expected { userId, packageId } strings.',
		)
	}
	return {
		userId: (parsed as { userId: string }).userId,
		packageId: (parsed as { packageId: string }).packageId,
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

async function listAppPackagesForAudit(input: {
	db: D1Database
	limit: number
	startAfter: PackageStorageAuditCursor | null
}): Promise<{ rows: Array<AppPackageRow>; truncated: boolean }> {
	const result = input.startAfter
		? await input.db
				.prepare(
					`SELECT user_id AS userId, id AS packageId, kody_id AS kodyId,
						source_id AS sourceId
					FROM saved_packages
					WHERE has_app = 1
						AND (user_id > ? OR (user_id = ? AND id > ?))
					ORDER BY user_id ASC, id ASC
					LIMIT ?`,
				)
				.bind(
					input.startAfter.userId,
					input.startAfter.userId,
					input.startAfter.packageId,
					input.limit + 1,
				)
				.all<AppPackageRow>()
		: await input.db
				.prepare(
					`SELECT user_id AS userId, id AS packageId, kody_id AS kodyId,
						source_id AS sourceId
					FROM saved_packages
					WHERE has_app = 1
					ORDER BY user_id ASC, id ASC
					LIMIT ?`,
				)
				.bind(input.limit + 1)
				.all<AppPackageRow>()
	const rows = result.results ?? []
	const truncated = rows.length > input.limit
	return {
		rows: truncated ? rows.slice(0, input.limit) : rows,
		truncated,
	}
}

async function listOrphanAppBuckets(input: { db: D1Database }): Promise<{
	rows: Array<PackageStorageAuditOrphanBucket>
	truncated: boolean
}> {
	const result = await input.db
		.prepare(
			`SELECT b.user_id AS userId, b.storage_id AS storageId,
				b.last_seen_at AS lastSeenAt
			FROM user_storage_buckets b
			LEFT JOIN saved_packages p
				ON p.id = b.storage_id AND p.user_id = b.user_id
			WHERE b.kind = 'app' AND p.id IS NULL
			ORDER BY b.user_id ASC, b.storage_id ASC
			LIMIT ?`,
		)
		.bind(maxOrphanAppBuckets + 1)
		.all<PackageStorageAuditOrphanBucket>()
	const rows = result.results ?? []
	const truncated = rows.length > maxOrphanAppBuckets
	return {
		rows: truncated ? rows.slice(0, maxOrphanAppBuckets) : rows,
		truncated,
	}
}

async function auditAppPackage(input: {
	env: Env
	baseUrl: string
	row: AppPackageRow
	budgets: ResolvedBudgets
}): Promise<PackageStorageAuditPackageRow> {
	const [legacyProbe, sourceScan] = await Promise.all([
		probeLegacyBucketBytes({
			env: input.env,
			userId: input.row.userId,
			packageId: input.row.packageId,
			timeoutMs: input.budgets.legacyBucketProbeMs,
		}),
		scanAmbientStorageImports({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.row.userId,
			sourceId: input.row.sourceId,
			timeoutMs: input.budgets.sourceScanMs,
		}),
	])

	return {
		userId: input.row.userId,
		packageId: input.row.packageId,
		kodyId: input.row.kodyId,
		legacyBucketBytes: legacyProbe.bytes,
		legacyBucketProbeError: legacyProbe.error,
		ambientStorageImportFiles: sourceScan.files,
		sourceScanError: sourceScan.error,
	}
}

async function probeLegacyBucketBytes(input: {
	env: Env
	userId: string
	packageId: string
	timeoutMs: number
}): Promise<{ bytes: number | null; error: string | null }> {
	try {
		const estimate = await withDeadline(
			storageRunnerRpc({
				env: input.env,
				userId: input.userId,
				storageId: input.packageId,
			}).getEstimatedBytes(),
			input.timeoutMs,
		)
		return { bytes: estimate.estimatedBytes, error: null }
	} catch (error) {
		return { bytes: null, error: getErrorMessage(error) }
	}
}

async function scanAmbientStorageImports(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceId: string
	timeoutMs: number
}): Promise<{ files: Array<string>; error: string | null }> {
	try {
		const loaded = await withDeadline(
			loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: input.sourceId,
			}),
			input.timeoutMs,
		)
		return {
			files: collectAmbientStorageImportFiles(loaded.files),
			error: null,
		}
	} catch (error) {
		return { files: [], error: getErrorMessage(error) }
	}
}
