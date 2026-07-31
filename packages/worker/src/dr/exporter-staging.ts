import { parseBackupFullManifest } from '@kody-internal/shared/backup-full-manifest.ts'
import {
	sealedFullManifestKey,
	stagingPrefix,
	type BackupR2BucketLabel,
	type R2IndexEntry,
} from '@kody-internal/shared/backup-staging.ts'
import {
	DrBackupPreconditionFailedError,
	type DrBackupS3Client,
} from '#worker/dr/backup-s3.ts'
import { sha256Hex } from '#worker/dr/sha256.ts'

export type IncrementalR2IndexEntry = R2IndexEntry & {
	etag: string
	uploaded: string
}

export function stagingChunkKey(
	day: string,
	kind: 'storage-index' | 'artifacts-index',
) {
	return `${stagingPrefix(day)}exporter/chunks/${kind}/`
}

export function stagingStorageDumpChunkKey(day: string, identity: string) {
	return `${stagingPrefix(day)}exporter/chunks/storage-dump/${encodeURIComponent(identity)}/`
}

export function stagingR2IndexChunkKey(
	day: string,
	label: BackupR2BucketLabel,
) {
	return `${stagingPrefix(day)}exporter/chunks/r2-index/${label}/`
}

type ChunkMetadata = {
	__drExporterChunk: {
		previousKey: string | null
	}
}

export async function putLinkedChunk(input: {
	s3: DrBackupS3Client
	keyPrefix: string
	entriesBody: string
	previousKey: string | null
}) {
	const metadata = {
		__drExporterChunk: { previousKey: input.previousKey },
	} satisfies ChunkMetadata
	const body = `${JSON.stringify(metadata)}\n${input.entriesBody}`
	const key = `${input.keyPrefix}${await sha256Hex(body)}.ndjson`
	try {
		await input.s3.put(key, body, {
			contentType: 'application/x-ndjson',
			ifNoneMatch: '*',
		})
	} catch (error) {
		if (!(error instanceof DrBackupPreconditionFailedError)) throw error
		const existing = await input.s3.getText(key)
		if (existing?.text !== body) {
			throw new Error(`DR exporter content-addressed chunk mismatch: ${key}`)
		}
	}
	return key
}

export async function putImmutableOutput(input: {
	s3: DrBackupS3Client
	key: string
	body: string
	contentType: string
}) {
	try {
		await input.s3.put(input.key, input.body, {
			contentType: input.contentType,
			ifNoneMatch: '*',
		})
		return input.body
	} catch (error) {
		if (!(error instanceof DrBackupPreconditionFailedError)) throw error
		const existing = await input.s3.getText(input.key)
		if (!existing) {
			throw new Error(`DR exporter immutable output disappeared: ${input.key}`)
		}
		return existing.text
	}
}

function parseNdjsonEntries<T>(body: string): Array<T> {
	return body
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as T)
}

function parseChunk(body: string) {
	const newlineIndex = body.indexOf('\n')
	if (newlineIndex < 0) throw new Error('DR exporter chunk metadata is missing')
	const metadata = JSON.parse(body.slice(0, newlineIndex)) as unknown
	if (
		!metadata ||
		typeof metadata !== 'object' ||
		Array.isArray(metadata) ||
		!('__drExporterChunk' in metadata)
	) {
		throw new Error('DR exporter chunk metadata is invalid')
	}
	const chunk = (metadata as ChunkMetadata).__drExporterChunk
	if (
		!chunk ||
		(chunk.previousKey !== null && typeof chunk.previousKey !== 'string')
	) {
		throw new Error('DR exporter chunk link is invalid')
	}
	return {
		previousKey: chunk.previousKey,
		entriesBody: body.slice(newlineIndex + 1),
	}
}

export async function readLinkedChunkBody(input: {
	s3: DrBackupS3Client
	headKey: string | null
	chunkCount: number
}) {
	const bodies: Array<string> = []
	let key = input.headKey
	for (let index = 0; index < input.chunkCount; index += 1) {
		if (!key) throw new Error('DR exporter chunk chain ended early')
		const chunk = await input.s3.getText(key)
		if (!chunk) {
			throw new Error(`DR exporter chunk missing: ${key}`)
		}
		const parsed = parseChunk(chunk.text)
		bodies.push(parsed.entriesBody)
		key = parsed.previousKey
	}
	if (key !== null) throw new Error('DR exporter chunk chain exceeds its count')
	return bodies.reverse().join('')
}

export async function readLinkedChunkEntries<T>(input: {
	s3: DrBackupS3Client
	headKey: string | null
	chunkCount: number
}): Promise<Array<T>> {
	return parseNdjsonEntries<T>(await readLinkedChunkBody(input))
}

function previousUtcDay(day: string, daysBack: number) {
	const date = new Date(`${day}T00:00:00.000Z`)
	date.setUTCDate(date.getUTCDate() - daysBack)
	return date.toISOString().slice(0, 10)
}

export async function resolvePreviousSealedDay(input: {
	s3: DrBackupS3Client
	day: string
	lookbackDays: number
}) {
	for (let daysBack = 1; daysBack <= input.lookbackDays; daysBack += 1) {
		const candidate = previousUtcDay(input.day, daysBack)
		const manifest = await input.s3.getText(sealedFullManifestKey(candidate))
		if (!manifest) continue
		try {
			const parsed = parseBackupFullManifest(
				JSON.parse(manifest.text) as unknown,
			)
			if (parsed.payload.day === candidate) return candidate
		} catch {
			// A malformed object is not eligible as a sealed incremental base.
		}
	}
	return null
}

function parseIncrementalR2Index(body: string) {
	const entries = new Map<string, IncrementalR2IndexEntry>()
	for (const value of parseNdjsonEntries<unknown>(body)) {
		if (!value || typeof value !== 'object' || Array.isArray(value)) continue
		const entry = value as Record<string, unknown>
		if (
			typeof entry.key !== 'string' ||
			typeof entry.size !== 'number' ||
			typeof entry.sha256 !== 'string' ||
			!/^[0-9a-f]{64}$/.test(entry.sha256) ||
			typeof entry.etag !== 'string' ||
			typeof entry.uploaded !== 'string'
		) {
			continue
		}
		entries.set(entry.key, entry as IncrementalR2IndexEntry)
	}
	return entries
}

export async function loadPreviousR2Index(input: {
	s3: DrBackupS3Client
	day: string | null
	label: BackupR2BucketLabel
}) {
	if (!input.day) return new Map<string, IncrementalR2IndexEntry>()
	const manifestText = await input.s3.getText(sealedFullManifestKey(input.day))
	if (!manifestText) return new Map<string, IncrementalR2IndexEntry>()
	try {
		const manifest = parseBackupFullManifest(
			JSON.parse(manifestText.text) as unknown,
		)
		const file = manifest.payload.r2Indexes[input.label]
		if (!file) return new Map<string, IncrementalR2IndexEntry>()
		const index = await input.s3.getText(file.objectKey)
		if (!index) return new Map<string, IncrementalR2IndexEntry>()
		if (
			new TextEncoder().encode(index.text).byteLength !== file.bytes ||
			(await sha256Hex(index.text)) !== file.sha256
		) {
			return new Map<string, IncrementalR2IndexEntry>()
		}
		return parseIncrementalR2Index(index.text)
	} catch {
		return new Map<string, IncrementalR2IndexEntry>()
	}
}
