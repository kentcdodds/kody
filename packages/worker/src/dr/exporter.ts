import {
	backupBlobKey,
	backupR2BucketLabels,
	backupStagingSchemaVersion,
	stagingArtifactsIndexKey,
	stagingPrefix,
	stagingR2IndexKey,
	stagingStorageDumpKey,
	stagingStorageIndexKey,
	stagingSummaryKey,
	type ArtifactsIndex,
	type ArtifactsIndexEntry,
	type BackupR2BucketLabel,
	type R2IndexEntry,
	type StagingFileSummary,
	type StagingSummary,
	type StorageDumpEntry,
	type StorageIndex,
	type StorageIndexEntry,
} from '@kody-internal/shared/backup-staging.ts'
import { buildPackageServiceStorageId } from '#worker/package-runtime/package-service.ts'
import { buildPublishedSourceSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import {
	createDrBackupS3Client,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'
import { encodeStorageIdentity } from '#worker/dr/storage-identity.ts'

export const drExportRunTimeBudgetMs = 20_000
export const drExportMaxObjectBytes = 100 * 1024 * 1024
const storageExportPageSize = 250
const exporterProgressSchemaVersion = 1 as const

export type DrExporterPhase =
	| 'storage'
	| 'r2'
	| 'artifacts'
	| 'finalize'
	| 'done'

export type DrExporterProgress = {
	schemaVersion: typeof exporterProgressSchemaVersion
	day: string
	startedAt: string
	phase: DrExporterPhase
	/** Next index into the platform storage inventory. */
	storageIndex: number
	/**
	 * Within the current storage dump: key cursor for exportStorage paging.
	 * Null means the next storage identity has not started yet.
	 */
	storagePageStartAfter: string | null
	/** Accumulated NDJSON for the in-progress storage dump (resumed pages). */
	storagePartialNdjson: string
	storagePartialEntryCount: number
	storageEntries: Array<StorageIndexEntry>
	/** Index into backupR2BucketLabels. */
	r2LabelIndex: number
	r2ListCursor: string | null
	/** Accumulated NDJSON for the in-progress R2 bucket index. */
	r2PartialNdjson: string
	r2Completed: Partial<Record<BackupR2BucketLabel, StagingFileSummary>>
	artifactsIndex: number
	artifactEntries: Array<ArtifactsIndexEntry>
	blobsWritten: number
	blobsReused: number
	warnings: Array<string>
}

export type DrExportTickResult = {
	day: string
	phase: DrExporterPhase
	timeBudgetExhausted: boolean
	skipped: boolean
	reason?: string
	storageDumpsCompleted: number
	r2ObjectsProcessed: number
	artifactsProcessed: number
	blobsWritten: number
	blobsReused: number
	warnings: number
	summaryWritten: boolean
}

type StorageInventoryEntry = {
	userId: string
	storageId: string
	identity: string
}

type ArtifactInventoryEntry = {
	sourceId: string
	userId: string
	entityKind: string
	entityId: string
	publishedCommit: string
}

function stagingProgressKey(day: string) {
	return `${stagingPrefix(day)}exporter/progress.json`
}

function formatUtcDay(date: Date) {
	return date.toISOString().slice(0, 10)
}

/**
 * Nightly DR export window: roughly 00:30–02:10 UTC on the worker's
 * every-5-minute cron. Ticks outside this window are skipped so daytime
 * traffic is not competing with a full-platform export.
 */
export function shouldRunDrExportCron(now: Date) {
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
	return minutes >= 30 && minutes <= 2 * 60 + 10
}

export function isDrExportConfigured(
	env: Pick<
		Env,
		| 'DR_EXPORT_ENABLED'
		| 'DR_BACKUP_ACCOUNT_ID'
		| 'DR_BACKUP_BUCKET_NAME'
		| 'DR_BACKUP_ACCESS_KEY_ID'
		| 'DR_BACKUP_SECRET_ACCESS_KEY'
	>,
) {
	return (
		env.DR_EXPORT_ENABLED?.trim() === 'true' &&
		readDrBackupS3Config(env) !== null
	)
}

function createInitialProgress(day: string, now: Date): DrExporterProgress {
	return {
		schemaVersion: exporterProgressSchemaVersion,
		day,
		startedAt: now.toISOString(),
		phase: 'storage',
		storageIndex: 0,
		storagePageStartAfter: null,
		storagePartialNdjson: '',
		storagePartialEntryCount: 0,
		storageEntries: [],
		r2LabelIndex: 0,
		r2ListCursor: null,
		r2PartialNdjson: '',
		r2Completed: {},
		artifactsIndex: 0,
		artifactEntries: [],
		blobsWritten: 0,
		blobsReused: 0,
		warnings: [],
	}
}

function parseProgress(value: unknown): DrExporterProgress | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (record.schemaVersion !== exporterProgressSchemaVersion) return null
	if (typeof record.day !== 'string' || typeof record.startedAt !== 'string') {
		return null
	}
	const phase = record.phase
	if (
		phase !== 'storage' &&
		phase !== 'r2' &&
		phase !== 'artifacts' &&
		phase !== 'finalize' &&
		phase !== 'done'
	) {
		return null
	}
	return value as DrExporterProgress
}

async function fileSummary(
	objectKey: string,
	body: string,
): Promise<StagingFileSummary> {
	const bytes = new TextEncoder().encode(body).byteLength
	return {
		objectKey,
		bytes,
		sha256: await sha256Hex(body),
	}
}

function ndjsonLine(value: unknown) {
	return `${JSON.stringify(value)}\n`
}

/**
 * Platform-wide StorageRunner inventory.
 *
 * Deliberate exception to per-user scoping: this operator-level DR exporter
 * iterates every user's storage ids so the sealed day can rebuild the whole
 * platform. Do not copy this pattern into user-facing read/write paths.
 */
export async function listPlatformStorageInventory(
	db: D1Database,
): Promise<Array<StorageInventoryEntry>> {
	const [jobRows, archivedRows, runtimeRows, packageRows, serviceRows] =
		await Promise.all([
			db
				.prepare(
					`SELECT user_id AS userId, storage_id AS storageId
					FROM jobs WHERE storage_id IS NOT NULL`,
				)
				.all<{ userId: string; storageId: string }>(),
			db
				.prepare(
					`SELECT user_id AS userId, storage_id AS storageId
					FROM archived_job_artifacts WHERE storage_id IS NOT NULL`,
				)
				.all<{ userId: string; storageId: string }>(),
			db
				.prepare(
					`SELECT user_id AS userId, storage_id AS storageId
					FROM package_runtime_runs WHERE storage_id IS NOT NULL`,
				)
				.all<{ userId: string; storageId: string }>(),
			db
				.prepare(
					`SELECT user_id AS userId, id AS storageId
					FROM saved_packages WHERE has_app = 1`,
				)
				.all<{ userId: string; storageId: string }>(),
			db
				.prepare(
					`SELECT DISTINCT user_id AS userId, package_id AS packageId, name AS serviceName
					FROM package_runtime_runs
					WHERE surface = 'service' AND name IS NOT NULL`,
				)
				.all<{
					userId: string
					packageId: string
					serviceName: string
				}>(),
		])

	const seen = new Set<string>()
	const inventory: Array<StorageInventoryEntry> = []
	const push = (userId: string, storageId: string) => {
		const identity = encodeStorageIdentity(userId, storageId)
		if (seen.has(identity)) return
		seen.add(identity)
		inventory.push({ userId, storageId, identity })
	}
	for (const row of jobRows.results ?? []) push(row.userId, row.storageId)
	for (const row of archivedRows.results ?? []) push(row.userId, row.storageId)
	for (const row of runtimeRows.results ?? []) push(row.userId, row.storageId)
	for (const row of packageRows.results ?? []) push(row.userId, row.storageId)
	for (const row of serviceRows.results ?? []) {
		push(
			row.userId,
			buildPackageServiceStorageId(row.packageId, row.serviceName),
		)
	}
	inventory.sort((left, right) => left.identity.localeCompare(right.identity))
	return inventory
}

export async function listPlatformArtifactInventory(
	db: D1Database,
): Promise<Array<ArtifactInventoryEntry>> {
	const result = await db
		.prepare(
			`SELECT id AS sourceId, user_id AS userId, entity_kind AS entityKind,
				entity_id AS entityId, published_commit AS publishedCommit
			FROM entity_sources
			WHERE published_commit IS NOT NULL AND trim(published_commit) != ''
			ORDER BY id ASC`,
		)
		.all<ArtifactInventoryEntry>()
	return result.results ?? []
}

async function putBlobIfAbsent(input: {
	s3: DrBackupS3Client
	sha256: string
	bytes: Uint8Array
	progress: DrExporterProgress
}): Promise<'written' | 'reused'> {
	const key = backupBlobKey(input.sha256)
	const head = await input.s3.head(key)
	if (head.exists) {
		input.progress.blobsReused += 1
		return 'reused'
	}
	await input.s3.put(key, input.bytes, 'application/octet-stream')
	input.progress.blobsWritten += 1
	return 'written'
}

function r2BindingForLabel(
	env: Pick<Env, 'EMAIL_BLOBS' | 'COMMUNITY_ASSETS'>,
	label: BackupR2BucketLabel,
): R2Bucket {
	switch (label) {
		case 'email-blobs':
			return env.EMAIL_BLOBS
		case 'community-assets':
			return env.COMMUNITY_ASSETS
		default: {
			const exhaustive: never = label
			throw new Error(`unknown R2 backup label: ${String(exhaustive)}`)
		}
	}
}

async function persistProgress(
	s3: DrBackupS3Client,
	progress: DrExporterProgress,
) {
	await s3.put(
		stagingProgressKey(progress.day),
		JSON.stringify(progress),
		'application/json',
	)
}

async function loadOrCreateProgress(input: {
	s3: DrBackupS3Client
	day: string
	now: Date
}): Promise<DrExporterProgress> {
	const raw = await input.s3.getText(stagingProgressKey(input.day))
	if (raw) {
		try {
			const parsed = parseProgress(JSON.parse(raw) as unknown)
			if (parsed && parsed.day === input.day) return parsed
		} catch {
			// Fall through and start fresh if progress is corrupt.
		}
	}
	return createInitialProgress(input.day, input.now)
}

async function exportStoragePhase(input: {
	env: Env
	s3: DrBackupS3Client
	progress: DrExporterProgress
	inventory: Array<StorageInventoryEntry>
	startedAtMs: number
	timeBudgetMs: number
	counts: { storageDumpsCompleted: number }
}): Promise<boolean> {
	const { progress, inventory, s3, env } = input
	while (progress.storageIndex < inventory.length) {
		if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
		const item = inventory[progress.storageIndex]!
		const page = await storageRunnerRpc({
			env,
			userId: item.userId,
			storageId: item.storageId,
		}).exportStorage({
			pageSize: storageExportPageSize,
			startAfter: progress.storagePageStartAfter,
		})
		for (const entry of page.entries) {
			const dumpEntry = {
				key: entry.key,
				valueJson: JSON.stringify(entry.value),
			} satisfies StorageDumpEntry
			progress.storagePartialNdjson += ndjsonLine(dumpEntry)
			progress.storagePartialEntryCount += 1
		}
		if (page.truncated && page.nextStartAfter) {
			progress.storagePageStartAfter = page.nextStartAfter
			await persistProgress(s3, progress)
			continue
		}
		const objectKey = stagingStorageDumpKey(progress.day, item.identity)
		const body = progress.storagePartialNdjson
		await s3.put(objectKey, body, 'application/x-ndjson')
		const summary = await fileSummary(objectKey, body)
		progress.storageEntries.push({
			storageId: item.identity,
			objectKey,
			entryCount: progress.storagePartialEntryCount,
			bytes: summary.bytes,
			sha256: summary.sha256,
		})
		progress.storageIndex += 1
		progress.storagePageStartAfter = null
		progress.storagePartialNdjson = ''
		progress.storagePartialEntryCount = 0
		input.counts.storageDumpsCompleted += 1
		await persistProgress(s3, progress)
	}
	progress.phase = 'r2'
	await persistProgress(s3, progress)
	return false
}

async function exportR2Phase(input: {
	env: Env
	s3: DrBackupS3Client
	progress: DrExporterProgress
	startedAtMs: number
	timeBudgetMs: number
	counts: { r2ObjectsProcessed: number }
}): Promise<boolean> {
	const { progress, s3, env } = input
	while (progress.r2LabelIndex < backupR2BucketLabels.length) {
		if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
		const label = backupR2BucketLabels[progress.r2LabelIndex]!
		const bucket = r2BindingForLabel(env, label)
		const listed = await bucket.list({
			cursor: progress.r2ListCursor ?? undefined,
			limit: 100,
		})
		for (const object of listed.objects) {
			if (Date.now() - input.startedAtMs >= input.timeBudgetMs) {
				await persistProgress(s3, progress)
				return true
			}
			if (object.size > drExportMaxObjectBytes) {
				progress.warnings.push(
					`Skipped ${label} object ${object.key}: size ${object.size} exceeds ${drExportMaxObjectBytes} bytes`,
				)
				input.counts.r2ObjectsProcessed += 1
				continue
			}
			const body = await bucket.get(object.key)
			if (!body) {
				progress.warnings.push(
					`Missing ${label} object during export: ${object.key}`,
				)
				input.counts.r2ObjectsProcessed += 1
				continue
			}
			const bytes = new Uint8Array(await body.arrayBuffer())
			const digest = await sha256Hex(bytes)
			await putBlobIfAbsent({ s3, sha256: digest, bytes, progress })
			const indexEntry = {
				key: object.key,
				size: bytes.byteLength,
				sha256: digest,
			} satisfies R2IndexEntry
			progress.r2PartialNdjson += ndjsonLine(indexEntry)
			input.counts.r2ObjectsProcessed += 1
		}
		if (listed.truncated) {
			progress.r2ListCursor = listed.cursor
			await persistProgress(s3, progress)
			continue
		}
		const objectKey = stagingR2IndexKey(progress.day, label)
		const body = progress.r2PartialNdjson
		await s3.put(objectKey, body, 'application/x-ndjson')
		progress.r2Completed[label] = await fileSummary(objectKey, body)
		progress.r2LabelIndex += 1
		progress.r2ListCursor = null
		progress.r2PartialNdjson = ''
		await persistProgress(s3, progress)
	}
	progress.phase = 'artifacts'
	await persistProgress(s3, progress)
	return false
}

async function exportArtifactsPhase(input: {
	env: Env
	s3: DrBackupS3Client
	progress: DrExporterProgress
	inventory: Array<ArtifactInventoryEntry>
	startedAtMs: number
	timeBudgetMs: number
	counts: { artifactsProcessed: number }
}): Promise<boolean> {
	const { progress, s3, env, inventory } = input
	while (progress.artifactsIndex < inventory.length) {
		if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
		const item = inventory[progress.artifactsIndex]!
		const kvKey = buildPublishedSourceSnapshotKvKey({
			sourceId: item.sourceId,
			publishedCommit: item.publishedCommit,
		})
		const snapshotText = await env.BUNDLE_ARTIFACTS_KV.get(kvKey)
		if (snapshotText === null) {
			progress.warnings.push(
				`Missing source snapshot KV key ${kvKey} for source ${item.sourceId}`,
			)
			progress.artifactsIndex += 1
			input.counts.artifactsProcessed += 1
			await persistProgress(s3, progress)
			continue
		}
		const bytes = new TextEncoder().encode(snapshotText)
		const digest = await sha256Hex(bytes)
		await putBlobIfAbsent({ s3, sha256: digest, bytes, progress })
		progress.artifactEntries.push({
			sourceId: item.sourceId,
			entityKind: item.entityKind,
			entityId: item.entityId,
			userId: item.userId,
			publishedCommit: item.publishedCommit,
			snapshotSha256: digest,
		})
		progress.artifactsIndex += 1
		input.counts.artifactsProcessed += 1
		await persistProgress(s3, progress)
	}
	progress.phase = 'finalize'
	await persistProgress(s3, progress)
	return false
}

async function finalizeExport(input: {
	env: Env
	s3: DrBackupS3Client
	progress: DrExporterProgress
	now: Date
}): Promise<StagingSummary> {
	const { progress, s3, env, now } = input
	const storageIndexBody = JSON.stringify({
		schemaVersion: backupStagingSchemaVersion,
		day: progress.day,
		entries: progress.storageEntries,
	} satisfies StorageIndex)
	const storageIndexKey = stagingStorageIndexKey(progress.day)
	await s3.put(storageIndexKey, storageIndexBody, 'application/json')
	const storageIndex = await fileSummary(storageIndexKey, storageIndexBody)

	const artifactsIndexBody = JSON.stringify({
		schemaVersion: backupStagingSchemaVersion,
		day: progress.day,
		entries: progress.artifactEntries,
	} satisfies ArtifactsIndex)
	const artifactsIndexKey = stagingArtifactsIndexKey(progress.day)
	await s3.put(artifactsIndexKey, artifactsIndexBody, 'application/json')
	const artifactsIndex = await fileSummary(
		artifactsIndexKey,
		artifactsIndexBody,
	)

	const summary: StagingSummary = {
		schemaVersion: backupStagingSchemaVersion,
		day: progress.day,
		startedAt: progress.startedAt,
		completedAt: now.toISOString(),
		buildCommit: env.APP_COMMIT_SHA?.trim() || 'unknown',
		storageIndex,
		r2Indexes: progress.r2Completed,
		artifactsIndex,
		blobsWritten: progress.blobsWritten,
		blobsReused: progress.blobsReused,
		warnings: progress.warnings,
	}
	await s3.put(
		stagingSummaryKey(progress.day),
		JSON.stringify(summary),
		'application/json',
	)
	progress.phase = 'done'
	await persistProgress(s3, progress)
	return summary
}

export async function runDrExportTick(input: {
	env: Env
	now?: Date
	timeBudgetMs?: number
	s3?: DrBackupS3Client
}): Promise<DrExportTickResult> {
	const now = input.now ?? new Date()
	const day = formatUtcDay(now)
	const empty = (reason: string): DrExportTickResult => ({
		day,
		phase: 'done',
		timeBudgetExhausted: false,
		skipped: true,
		reason,
		storageDumpsCompleted: 0,
		r2ObjectsProcessed: 0,
		artifactsProcessed: 0,
		blobsWritten: 0,
		blobsReused: 0,
		warnings: 0,
		summaryWritten: false,
	})

	if (!shouldRunDrExportCron(now)) {
		return empty('outside-nightly-window')
	}
	if (!isDrExportConfigured(input.env)) {
		return empty('not-configured')
	}
	const config = readDrBackupS3Config(input.env)
	if (!config) return empty('not-configured')
	const s3 = input.s3 ?? createDrBackupS3Client(config)

	const existingSummary = await s3.getText(stagingSummaryKey(day))
	if (existingSummary) {
		return empty('already-complete')
	}

	const timeBudgetMs = input.timeBudgetMs ?? drExportRunTimeBudgetMs
	const startedAtMs = Date.now()
	const progress = await loadOrCreateProgress({ s3, day, now })
	const counts = {
		storageDumpsCompleted: 0,
		r2ObjectsProcessed: 0,
		artifactsProcessed: 0,
	}
	let timeBudgetExhausted = false

	if (progress.phase === 'storage') {
		const inventory = await listPlatformStorageInventory(input.env.APP_DB)
		timeBudgetExhausted = await exportStoragePhase({
			env: input.env,
			s3,
			progress,
			inventory,
			startedAtMs,
			timeBudgetMs,
			counts,
		})
	}
	if (!timeBudgetExhausted && progress.phase === 'r2') {
		timeBudgetExhausted = await exportR2Phase({
			env: input.env,
			s3,
			progress,
			startedAtMs,
			timeBudgetMs,
			counts,
		})
	}
	if (!timeBudgetExhausted && progress.phase === 'artifacts') {
		const inventory = await listPlatformArtifactInventory(input.env.APP_DB)
		timeBudgetExhausted = await exportArtifactsPhase({
			env: input.env,
			s3,
			progress,
			inventory,
			startedAtMs,
			timeBudgetMs,
			counts,
		})
	}
	let summaryWritten = false
	if (!timeBudgetExhausted && progress.phase === 'finalize') {
		await finalizeExport({ env: input.env, s3, progress, now })
		summaryWritten = true
	}

	const result: DrExportTickResult = {
		day,
		phase: progress.phase,
		timeBudgetExhausted,
		skipped: false,
		storageDumpsCompleted: counts.storageDumpsCompleted,
		r2ObjectsProcessed: counts.r2ObjectsProcessed,
		artifactsProcessed: counts.artifactsProcessed,
		blobsWritten: progress.blobsWritten,
		blobsReused: progress.blobsReused,
		warnings: progress.warnings.length,
		summaryWritten,
	}
	console.info('dr_export_tick', JSON.stringify(result))
	return result
}

export function __testOnlyCreateInitialProgress(day: string, now: Date) {
	return createInitialProgress(day, now)
}

export function __testOnlyParseProgress(value: unknown) {
	return parseProgress(value)
}
