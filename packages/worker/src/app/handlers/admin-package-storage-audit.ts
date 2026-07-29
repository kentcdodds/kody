import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type Action } from 'remix/router'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type routes } from '#app/routes.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { readPositiveInt } from '#worker/query-params.ts'
import { collectAmbientStorageImportFiles } from '#worker/repo/checks.ts'
import {
	emptyStorageRunnerEstimatedBytes,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'

const defaultAppPackageLimit = 200
const maxAppPackageLimit = 500
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
	totals: {
		appPackages: number
		nonEmptyLegacyBuckets: number
		packagesWithAmbientImports: number
		orphanAppBuckets: number
		truncated: boolean
		orphanTruncated: boolean
	}
}

type AppPackageRow = {
	userId: string
	packageId: string
	kodyId: string
	sourceId: string
}

export function createAdminPackageStorageAuditApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method !== 'GET') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}
				await requireUserWithRole(request, env, 'admin')
				const limit = readPositiveInt(
					url.searchParams.get('limit'),
					defaultAppPackageLimit,
					maxAppPackageLimit,
				)
				const report = await buildPackageStorageAuditReport({
					env,
					baseUrl: url.origin,
					limit,
				})
				return jsonResponse(report)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminPackageStorageAuditApi>
}

export async function buildPackageStorageAuditReport(input: {
	env: Env
	baseUrl: string
	limit: number
}): Promise<PackageStorageAuditReport> {
	const [appPackagePage, orphanPage] = await Promise.all([
		listAppPackagesForAudit({
			db: input.env.APP_DB,
			limit: input.limit,
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
				}),
			),
		)
		packages.push(...chunkRows)
	}

	return {
		ok: true,
		packages,
		orphanAppBuckets: orphanPage.rows,
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

async function listAppPackagesForAudit(input: {
	db: D1Database
	limit: number
}): Promise<{ rows: Array<AppPackageRow>; truncated: boolean }> {
	const result = await input.db
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
}): Promise<PackageStorageAuditPackageRow> {
	const [legacyProbe, sourceScan] = await Promise.all([
		probeLegacyBucketBytes({
			env: input.env,
			userId: input.row.userId,
			packageId: input.row.packageId,
		}),
		scanAmbientStorageImports({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.row.userId,
			sourceId: input.row.sourceId,
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
}): Promise<{ bytes: number | null; error: string | null }> {
	try {
		const estimate = await storageRunnerRpc({
			env: input.env,
			userId: input.userId,
			storageId: input.packageId,
		}).getEstimatedBytes()
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
}): Promise<{ files: Array<string>; error: string | null }> {
	try {
		const loaded = await loadPackageSourceBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: input.sourceId,
		})
		return {
			files: collectAmbientStorageImportFiles(loaded.files),
			error: null,
		}
	} catch (error) {
		return { files: [], error: getErrorMessage(error) }
	}
}
