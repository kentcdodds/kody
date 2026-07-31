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
	type StagingFileSummary,
	type StagingSummary,
	type StorageDumpEntry,
	type StorageIndex,
	type StorageIndexEntry,
} from '@kody-internal/shared/backup-staging.ts'
import { buildPublishedSourceSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import {
	createDrBackupS3Client,
	DrBackupPreconditionFailedError,
	readDrBackupS3Config,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'
import {
	loadPreviousR2Index,
	putImmutableOutput,
	putLinkedChunk,
	readLinkedChunkBody,
	readLinkedChunkEntries,
	resolvePreviousSealedDay,
	stagingChunkKey,
	stagingR2IndexChunkKey,
	stagingStorageDumpChunkKey,
	type IncrementalR2IndexEntry,
} from '#worker/dr/exporter-staging.ts'
import {
	listPlatformArtifactInventory,
	listPlatformStorageInventory,
	type ArtifactInventoryEntry,
	type StorageInventoryEntry,
} from '#worker/dr/exporter-inventory.ts'
import {
	isDrExportConfigured,
	shouldRunDrExportCron,
} from '#worker/dr/exporter-schedule.ts'

export { listPlatformStorageInventory } from '#worker/dr/exporter-inventory.ts'
export {
	isDrExportConfigured,
	shouldRunDrExportCron,
	shouldRunDrExportWatchdogCron,
} from '#worker/dr/exporter-schedule.ts'

export const drExportRunTimeBudgetMs = 20_000
/** Skip individual R2 objects larger than this (full-buffer ceiling). */
export const drExportMaxObjectBytes = 25 * 1024 * 1024
/** Cap for an assembled storage dump before it is admitted to the index. */
export const drExportMaxStorageDumpBufferBytes = 16 * 1024 * 1024
const storageExportPageSize = 250
const indexChunkEntryLimit = 100
const previousSealedDayLookbackDays = 35
const progressLeaseDurationMs = 2 * 60_000
const exporterProgressSchemaVersion = 2 as const

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
	/** Monotonic counter bumped on every progress persist. */
	revision: number
	leaseId: string | null
	leaseExpiresAt: string | null
	/**
	 * Count of storage identities completed or skipped. The inventory is
	 * re-listed every tick and can drift mid-run (jobs registering new
	 * buckets), so resume is identity-driven, not positional; this field is
	 * observability only.
	 */
	storageIndex: number
	/**
	 * Within the current storage dump: key cursor for exportStorage paging.
	 * Null means the next storage identity has not started yet.
	 */
	storagePageStartAfter: string | null
	/**
	 * Identity the partial page state below belongs to. Guards resumed
	 * partial pages against inventory drift between ticks; absent/mismatched
	 * identity resets the partial state.
	 */
	storagePartialIdentity?: string | null
	/** Number of page chunks written for the in-progress storage dump. */
	storageDumpChunkCount: number
	storageDumpChunkHead: string | null
	storagePartialEntryCount: number
	storagePartialBytes: number
	storageEntryChunkCount: number
	storageEntryChunkHead: string | null
	/** Bounded tail; full chunks live under exporter/chunks/storage-index/. */
	storagePendingEntries: Array<StorageIndexEntry>
	/** Index into backupR2BucketLabels. */
	r2LabelIndex: number
	r2ListCursor: string | null
	r2ChunkCount: number
	r2ChunkHead: string | null
	r2FinalPageReady: boolean
	r2Completed: Partial<Record<BackupR2BucketLabel, StagingFileSummary>>
	previousSealedDayResolved: boolean
	previousSealedDay: string | null
	artifactsIndex: number
	artifactEntryChunkCount: number
	artifactEntryChunkHead: string | null
	/** Bounded tail; full chunks live under exporter/chunks/artifacts-index/. */
	artifactPendingEntries: Array<ArtifactsIndexEntry>
	blobsWritten: number
	blobsReused: number
	warnings: Array<string>
}

type ProgressSession = {
	progress: DrExporterProgress
	/** ETag of the loaded progress object, or null when creating. */
	etag: string | null
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

function stagingProgressKey(day: string) {
	return `${stagingPrefix(day)}exporter/progress.json`
}

function formatUtcDay(date: Date) {
	return date.toISOString().slice(0, 10)
}

function utf8ByteLength(value: string) {
	return new TextEncoder().encode(value).byteLength
}

function createInitialProgress(day: string, now: Date): DrExporterProgress {
	return {
		schemaVersion: exporterProgressSchemaVersion,
		day,
		startedAt: now.toISOString(),
		phase: 'storage',
		revision: 0,
		leaseId: null,
		leaseExpiresAt: null,
		storageIndex: 0,
		storagePageStartAfter: null,
		storagePartialIdentity: null,
		storageDumpChunkCount: 0,
		storageDumpChunkHead: null,
		storagePartialEntryCount: 0,
		storagePartialBytes: 0,
		storageEntryChunkCount: 0,
		storageEntryChunkHead: null,
		storagePendingEntries: [],
		r2LabelIndex: 0,
		r2ListCursor: null,
		r2ChunkCount: 0,
		r2ChunkHead: null,
		r2FinalPageReady: false,
		r2Completed: {},
		previousSealedDayResolved: false,
		previousSealedDay: null,
		artifactsIndex: 0,
		artifactEntryChunkCount: 0,
		artifactEntryChunkHead: null,
		artifactPendingEntries: [],
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
	const revision =
		typeof record.revision === 'number' && Number.isSafeInteger(record.revision)
			? record.revision
			: 0
	return { ...(value as DrExporterProgress), revision }
}

async function fileSummary(
	objectKey: string,
	body: string,
): Promise<StagingFileSummary> {
	const bytes = utf8ByteLength(body)
	return {
		objectKey,
		bytes,
		sha256: await sha256Hex(body),
	}
}

function ndjsonLine(value: unknown) {
	return `${JSON.stringify(value)}\n`
}

function ndjsonEntryCount(body: string) {
	return body.split('\n').filter(Boolean).length
}

async function flushStorageEntryChunk(input: {
	s3: DrBackupS3Client
	progress: DrExporterProgress
}) {
	if (input.progress.storagePendingEntries.length === 0) return
	const body = input.progress.storagePendingEntries.map(ndjsonLine).join('')
	input.progress.storageEntryChunkHead = await putLinkedChunk({
		s3: input.s3,
		keyPrefix: stagingChunkKey(input.progress.day, 'storage-index'),
		entriesBody: body,
		previousKey: input.progress.storageEntryChunkHead,
	})
	input.progress.storageEntryChunkCount += 1
	input.progress.storagePendingEntries = []
}

async function flushArtifactEntryChunk(input: {
	s3: DrBackupS3Client
	progress: DrExporterProgress
}) {
	if (input.progress.artifactPendingEntries.length === 0) return
	const body = input.progress.artifactPendingEntries.map(ndjsonLine).join('')
	input.progress.artifactEntryChunkHead = await putLinkedChunk({
		s3: input.s3,
		keyPrefix: stagingChunkKey(input.progress.day, 'artifacts-index'),
		entriesBody: body,
		previousKey: input.progress.artifactEntryChunkHead,
	})
	input.progress.artifactEntryChunkCount += 1
	input.progress.artifactPendingEntries = []
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
	await input.s3.put(key, input.bytes, {
		contentType: 'application/octet-stream',
	})
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

/**
 * Persist progress with a conditional PUT so overlapping cron ticks cannot
 * last-write-wins corrupt the day. R2's S3 API honors If-Match / If-None-Match
 * on PutObject (412 PreconditionFailed on conflict).
 */
async function persistProgress(s3: DrBackupS3Client, session: ProgressSession) {
	if (session.progress.leaseId) {
		session.progress.leaseExpiresAt = new Date(
			Date.now() + progressLeaseDurationMs,
		).toISOString()
	}
	session.progress.revision += 1
	const body = JSON.stringify(session.progress)
	const key = stagingProgressKey(session.progress.day)
	const result = await s3.put(key, body, {
		contentType: 'application/json',
		...(session.etag ? { ifMatch: session.etag } : { ifNoneMatch: '*' }),
	})
	session.etag = result.etag ?? session.etag
}

async function loadOrCreateProgress(input: {
	s3: DrBackupS3Client
	day: string
	now: Date
}): Promise<ProgressSession> {
	const loaded = await input.s3.getText(stagingProgressKey(input.day))
	if (loaded) {
		try {
			const parsed = parseProgress(JSON.parse(loaded.text) as unknown)
			if (parsed && parsed.day === input.day) {
				return { progress: parsed, etag: loaded.etag }
			}
		} catch {
			// Fall through and replace corrupt progress under If-Match.
		}
		return {
			progress: createInitialProgress(input.day, input.now),
			etag: loaded.etag,
		}
	}
	return {
		progress: createInitialProgress(input.day, input.now),
		etag: null,
	}
}

const oversizedStorageDumpWarningPrefix = 'storage dump too large: '

function resetPartialStorageState(progress: DrExporterProgress) {
	progress.storagePageStartAfter = null
	progress.storagePartialIdentity = null
	progress.storageDumpChunkCount = 0
	progress.storageDumpChunkHead = null
	progress.storagePartialEntryCount = 0
	progress.storagePartialBytes = 0
}

function skipOversizedStorageDump(
	progress: DrExporterProgress,
	identity: string,
) {
	progress.warnings.push(`${oversizedStorageDumpWarningPrefix}${identity}`)
	progress.storageIndex += 1
	resetPartialStorageState(progress)
}

async function collectHandledStorageIdentities(input: {
	s3: DrBackupS3Client
	progress: DrExporterProgress
}) {
	const chunkEntries = await readLinkedChunkEntries<StorageIndexEntry>({
		s3: input.s3,
		headKey: input.progress.storageEntryChunkHead,
		chunkCount: input.progress.storageEntryChunkCount,
	})
	const handled = new Set([
		...chunkEntries.map((entry) => entry.storageId),
		...input.progress.storagePendingEntries.map((entry) => entry.storageId),
	])
	for (const warning of input.progress.warnings) {
		if (warning.startsWith(oversizedStorageDumpWarningPrefix)) {
			handled.add(warning.slice(oversizedStorageDumpWarningPrefix.length))
		}
	}
	return handled
}

async function exportStoragePhase(input: {
	env: Env
	s3: DrBackupS3Client
	session: ProgressSession
	inventory: Array<StorageInventoryEntry>
	startedAtMs: number
	timeBudgetMs: number
	counts: { storageDumpsCompleted: number }
}): Promise<boolean> {
	const { session, inventory, s3, env } = input
	const { progress } = session
	// Identity-driven resume: the inventory is re-listed every tick and can
	// drift mid-run (jobs registering new buckets during the export window),
	// which shifts positions in the sorted list. A positional cursor then
	// dumps the same identity twice — producing duplicate storage-index
	// entries that later wedge sealing — or silently skips identities.
	const handledIdentities = await collectHandledStorageIdentities({
		s3,
		progress,
	})
	let inventoryIndex = 0
	for (;;) {
		if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
		let item: StorageInventoryEntry | undefined
		while (inventoryIndex < inventory.length) {
			const candidate = inventory[inventoryIndex]!
			inventoryIndex += 1
			if (!handledIdentities.has(candidate.identity)) {
				item = candidate
				break
			}
		}
		if (!item) break
		if (progress.storagePartialIdentity !== item.identity) {
			// The persisted partial page state belongs to a different (drifted)
			// identity; restart this identity's dump from its first page.
			resetPartialStorageState(progress)
			progress.storagePartialIdentity = item.identity
		}
		const page = await storageRunnerRpc({
			env,
			userId: item.userId,
			storageId: item.storageId,
		}).exportStorage({
			pageSize: storageExportPageSize,
			startAfter: progress.storagePageStartAfter,
		})
		let pageBody = ''
		for (const entry of page.entries) {
			const dumpEntry = {
				key: entry.key,
				valueJson: JSON.stringify(entry.value),
			} satisfies StorageDumpEntry
			pageBody += ndjsonLine(dumpEntry)
			progress.storagePartialEntryCount += 1
		}
		const pageBytes = utf8ByteLength(pageBody)
		if (
			progress.storagePartialBytes + pageBytes >
			drExportMaxStorageDumpBufferBytes
		) {
			skipOversizedStorageDump(progress, item.identity)
			handledIdentities.add(item.identity)
			await persistProgress(s3, session)
			continue
		}
		if (pageBody.length > 0) {
			progress.storageDumpChunkHead = await putLinkedChunk({
				s3,
				keyPrefix: stagingStorageDumpChunkKey(progress.day, item.identity),
				entriesBody: pageBody,
				previousKey: progress.storageDumpChunkHead,
			})
			progress.storageDumpChunkCount += 1
			progress.storagePartialBytes += pageBytes
		}
		if (page.truncated && page.nextStartAfter) {
			progress.storagePageStartAfter = page.nextStartAfter
			await persistProgress(s3, session)
			continue
		}
		const objectKey = stagingStorageDumpKey(progress.day, item.identity)
		const body = await readLinkedChunkBody({
			s3,
			headKey: progress.storageDumpChunkHead,
			chunkCount: progress.storageDumpChunkCount,
		})
		const storedBody = await putImmutableOutput({
			s3,
			key: objectKey,
			body,
			contentType: 'application/x-ndjson',
		})
		const summary = await fileSummary(objectKey, storedBody)
		progress.storagePendingEntries.push({
			storageId: item.identity,
			objectKey,
			entryCount: ndjsonEntryCount(storedBody),
			bytes: summary.bytes,
			sha256: summary.sha256,
		})
		if (progress.storagePendingEntries.length >= indexChunkEntryLimit) {
			await flushStorageEntryChunk({ s3, progress })
		}
		handledIdentities.add(item.identity)
		progress.storageIndex += 1
		resetPartialStorageState(progress)
		input.counts.storageDumpsCompleted += 1
		await persistProgress(s3, session)
	}
	await flushStorageEntryChunk({ s3, progress })
	progress.phase = 'r2'
	await persistProgress(s3, session)
	return false
}

async function exportR2Phase(input: {
	env: Env
	s3: DrBackupS3Client
	session: ProgressSession
	startedAtMs: number
	timeBudgetMs: number
	counts: { r2ObjectsProcessed: number }
}): Promise<boolean> {
	const { session, s3, env } = input
	const { progress } = session
	if (!progress.previousSealedDayResolved) {
		progress.previousSealedDay = await resolvePreviousSealedDay({
			s3,
			day: progress.day,
			lookbackDays: previousSealedDayLookbackDays,
		})
		progress.previousSealedDayResolved = true
		await persistProgress(s3, session)
	}
	while (progress.r2LabelIndex < backupR2BucketLabels.length) {
		const label = backupR2BucketLabels[progress.r2LabelIndex]!
		const bucket = r2BindingForLabel(env, label)
		if (!progress.r2FinalPageReady) {
			const previousEntries = await loadPreviousR2Index({
				s3,
				day: progress.previousSealedDay,
				label,
			})
			for (;;) {
				if (Date.now() - input.startedAtMs >= input.timeBudgetMs) return true
				const listed = await bucket.list({
					cursor: progress.r2ListCursor ?? undefined,
					limit: 100,
				})
				// Finish the whole list page before checking the tick budget.
				// Persisting mid-page without advancing r2ListCursor would replay
				// its index lines. List pages are bounded (≤100).
				let pageIndexBody = ''
				for (const object of listed.objects) {
					if (object.size > drExportMaxObjectBytes) {
						progress.warnings.push(
							`Skipped ${label} object ${object.key}: size ${object.size} exceeds ${drExportMaxObjectBytes} bytes`,
						)
						input.counts.r2ObjectsProcessed += 1
						continue
					}
					const uploaded = object.uploaded.toISOString()
					const previous = previousEntries.get(object.key)
					if (
						previous &&
						previous.size === object.size &&
						previous.etag === object.etag &&
						previous.uploaded === uploaded &&
						(await s3.head(backupBlobKey(previous.sha256))).exists
					) {
						const indexEntry = {
							key: object.key,
							size: object.size,
							sha256: previous.sha256,
							etag: object.etag,
							uploaded,
						} satisfies IncrementalR2IndexEntry
						pageIndexBody += ndjsonLine(indexEntry)
						progress.blobsReused += 1
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
						etag: object.etag,
						uploaded,
					} satisfies IncrementalR2IndexEntry
					pageIndexBody += ndjsonLine(indexEntry)
					input.counts.r2ObjectsProcessed += 1
				}
				if (pageIndexBody.length > 0) {
					progress.r2ChunkHead = await putLinkedChunk({
						s3,
						keyPrefix: stagingR2IndexChunkKey(progress.day, label),
						entriesBody: pageIndexBody,
						previousKey: progress.r2ChunkHead,
					})
					progress.r2ChunkCount += 1
				}
				if (listed.truncated) {
					progress.r2ListCursor = listed.cursor
					await persistProgress(s3, session)
					continue
				}
				progress.r2FinalPageReady = true
				await persistProgress(s3, session)
				break
			}
		}
		const objectKey = stagingR2IndexKey(progress.day, label)
		const body = await readLinkedChunkBody({
			s3,
			headKey: progress.r2ChunkHead,
			chunkCount: progress.r2ChunkCount,
		})
		const storedBody = await putImmutableOutput({
			s3,
			key: objectKey,
			body,
			contentType: 'application/x-ndjson',
		})
		progress.r2Completed[label] = await fileSummary(objectKey, storedBody)
		progress.r2LabelIndex += 1
		progress.r2ListCursor = null
		progress.r2ChunkCount = 0
		progress.r2ChunkHead = null
		progress.r2FinalPageReady = false
		await persistProgress(s3, session)
	}
	progress.phase = 'artifacts'
	await persistProgress(s3, session)
	return false
}

async function exportArtifactsPhase(input: {
	env: Env
	s3: DrBackupS3Client
	session: ProgressSession
	inventory: Array<ArtifactInventoryEntry>
	startedAtMs: number
	timeBudgetMs: number
	counts: { artifactsProcessed: number }
}): Promise<boolean> {
	const { session, s3, env, inventory } = input
	const { progress } = session
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
			await persistProgress(s3, session)
			continue
		}
		const bytes = new TextEncoder().encode(snapshotText)
		const digest = await sha256Hex(bytes)
		await putBlobIfAbsent({ s3, sha256: digest, bytes, progress })
		progress.artifactPendingEntries.push({
			sourceId: item.sourceId,
			entityKind: item.entityKind,
			entityId: item.entityId,
			userId: item.userId,
			publishedCommit: item.publishedCommit,
			snapshotSha256: digest,
		})
		if (progress.artifactPendingEntries.length >= indexChunkEntryLimit) {
			await flushArtifactEntryChunk({ s3, progress })
		}
		progress.artifactsIndex += 1
		input.counts.artifactsProcessed += 1
		await persistProgress(s3, session)
	}
	await flushArtifactEntryChunk({ s3, progress })
	progress.phase = 'finalize'
	await persistProgress(s3, session)
	return false
}

async function finalizeExport(input: {
	env: Env
	s3: DrBackupS3Client
	session: ProgressSession
	now: Date
}): Promise<StagingSummary> {
	const { session, s3, env, now } = input
	const { progress } = session
	const storageEntries = await readLinkedChunkEntries<StorageIndexEntry>({
		s3,
		headKey: progress.storageEntryChunkHead,
		chunkCount: progress.storageEntryChunkCount,
	})
	const storageIndexBody = JSON.stringify({
		schemaVersion: backupStagingSchemaVersion,
		day: progress.day,
		entries: storageEntries,
	} satisfies StorageIndex)
	const storageIndexKey = stagingStorageIndexKey(progress.day)
	const storedStorageIndexBody = await putImmutableOutput({
		s3,
		key: storageIndexKey,
		body: storageIndexBody,
		contentType: 'application/json',
	})
	const storageIndex = await fileSummary(
		storageIndexKey,
		storedStorageIndexBody,
	)

	const artifactEntries = await readLinkedChunkEntries<ArtifactsIndexEntry>({
		s3,
		headKey: progress.artifactEntryChunkHead,
		chunkCount: progress.artifactEntryChunkCount,
	})
	const artifactsIndexBody = JSON.stringify({
		schemaVersion: backupStagingSchemaVersion,
		day: progress.day,
		entries: artifactEntries,
	} satisfies ArtifactsIndex)
	const artifactsIndexKey = stagingArtifactsIndexKey(progress.day)
	const storedArtifactsIndexBody = await putImmutableOutput({
		s3,
		key: artifactsIndexKey,
		body: artifactsIndexBody,
		contentType: 'application/json',
	})
	const artifactsIndex = await fileSummary(
		artifactsIndexKey,
		storedArtifactsIndexBody,
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
	await putImmutableOutput({
		s3,
		key: stagingSummaryKey(progress.day),
		body: JSON.stringify(summary),
		contentType: 'application/json',
	})
	progress.phase = 'done'
	await persistProgress(s3, session)
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
	const session = await loadOrCreateProgress({ s3, day, now })
	const { progress } = session
	const counts = {
		storageDumpsCompleted: 0,
		r2ObjectsProcessed: 0,
		artifactsProcessed: 0,
	}
	let timeBudgetExhausted = false

	try {
		const leaseExpiresAtMs = Date.parse(progress.leaseExpiresAt ?? '')
		if (
			progress.leaseId &&
			Number.isFinite(leaseExpiresAtMs) &&
			leaseExpiresAtMs > Date.now()
		) {
			return empty('progress-lease-active')
		}
		progress.leaseId = crypto.randomUUID()
		await persistProgress(s3, session)

		if (progress.phase === 'storage') {
			const inventory = await listPlatformStorageInventory(input.env.APP_DB)
			timeBudgetExhausted = await exportStoragePhase({
				env: input.env,
				s3,
				session,
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
				session,
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
				session,
				inventory,
				startedAtMs,
				timeBudgetMs,
				counts,
			})
		}
		let summaryWritten = false
		if (!timeBudgetExhausted && progress.phase === 'finalize') {
			await finalizeExport({ env: input.env, s3, session, now })
			summaryWritten = true
		}
		progress.leaseId = null
		progress.leaseExpiresAt = null
		await persistProgress(s3, session)

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
	} catch (error) {
		if (error instanceof DrBackupPreconditionFailedError) {
			// Another scheduled invocation owns this day's progress.json.
			console.info(
				'dr_export_tick',
				JSON.stringify({
					day,
					skipped: true,
					reason: 'progress-precondition-failed',
				}),
			)
			return empty('progress-precondition-failed')
		}
		throw error
	}
}

export type DrExportWatchdogResult = {
	day: string
	skipped: boolean
	reason?: string
	summaryPresent: boolean
}

/**
 * Post-window health check for the nightly staging exporter. Throws when the
 * day's `exporter/summary.json` is missing so the scheduled-lane handler
 * reports the failure to Sentry — an incomplete night is otherwise silent
 * (the exporter just stops getting ticks when the window closes).
 */
export async function runDrExportWatchdogTick(input: {
	env: Env
	now?: Date
	s3?: DrBackupS3Client
}): Promise<DrExportWatchdogResult> {
	const now = input.now ?? new Date()
	const day = formatUtcDay(now)
	if (!isDrExportConfigured(input.env)) {
		return {
			day,
			skipped: true,
			reason: 'not-configured',
			summaryPresent: false,
		}
	}
	const config = readDrBackupS3Config(input.env)
	if (!config) {
		return {
			day,
			skipped: true,
			reason: 'not-configured',
			summaryPresent: false,
		}
	}
	const s3 = input.s3 ?? createDrBackupS3Client(config)
	const summary = await s3.getText(stagingSummaryKey(day))
	if (summary) {
		console.info(
			'dr_export_watchdog',
			JSON.stringify({ day, summaryPresent: true }),
		)
		return { day, skipped: false, summaryPresent: true }
	}
	const progressText = await s3.getText(stagingProgressKey(day))
	let phase = 'missing'
	let detail = ''
	if (progressText) {
		const progress = parseProgress(JSON.parse(progressText.text) as unknown)
		if (progress) {
			phase = progress.phase
			detail = ` storageIndex=${progress.storageIndex} artifactsIndex=${progress.artifactsIndex} revision=${progress.revision} warnings=${progress.warnings.length}`
		}
	}
	throw new Error(
		`DR staging summary missing for ${day} after the export window closed (progress phase=${phase}${detail}). The night's non-D1 backup is incomplete and the day cannot be sealed.`,
	)
}

export function __testOnlyCreateInitialProgress(day: string, now: Date) {
	return createInitialProgress(day, now)
}

export function __testOnlyParseProgress(value: unknown) {
	return parseProgress(value)
}
