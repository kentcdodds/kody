import {
	parseBackupFullManifest,
	serializeBackupFullManifest,
	type BackupFullFileRef,
	type BackupFullManifest,
} from '@kody-internal/shared/backup-full-manifest.ts'
import {
	assertBackupDay,
	backupBlobKey,
	backupR2BucketLabels,
	parseStagingSummary,
	sealedFullManifestKey,
	sealedFullPrefix,
	stagingPrefix,
	stagingSummaryKey,
	type StagingFileSummary,
	type StagingSummary,
	type StorageIndex,
} from '@kody-internal/shared/backup-staging.ts'

import {
	BackupError,
	backupPayload,
	errorCode,
	safeLog,
	utcDay,
} from './backup-policy.ts'
import { type BackupEnvironment } from './backup-types.ts'
import {
	signBackupFullManifest,
	verifyBackupFullManifestSignature,
} from './full-manifest-signing.ts'
import {
	isBucketLockPolicyPutError,
	readManifest,
} from './immutable-storage.ts'
import { verifyBackupManifestSignature } from './manifest-signing.ts'

const sha256Pattern = /^[0-9a-f]{64}$/

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const copy = Uint8Array.from(bytes)
	return hex(await crypto.subtle.digest('SHA-256', copy))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseStorageIndex(value: unknown, day: string): StorageIndex {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.day !== day ||
		!Array.isArray(value.entries)
	) {
		throw new BackupError(
			'storage-index-corrupt',
			'storage index JSON is corrupt',
		)
	}
	for (const entry of value.entries) {
		if (
			!isRecord(entry) ||
			typeof entry.storageId !== 'string' ||
			typeof entry.objectKey !== 'string' ||
			!Number.isSafeInteger(entry.entryCount) ||
			!Number.isSafeInteger(entry.bytes) ||
			typeof entry.sha256 !== 'string' ||
			!sha256Pattern.test(entry.sha256)
		) {
			throw new BackupError(
				'storage-index-corrupt',
				'storage index entry is corrupt',
			)
		}
	}
	return value as StorageIndex
}

function sealedKeyForStagingObject(day: string, stagingKey: string): string {
	const prefix = stagingPrefix(day)
	if (!stagingKey.startsWith(prefix)) {
		throw new BackupError(
			'staging-key-outside-day',
			'staged object key is outside the day prefix',
		)
	}
	return `${sealedFullPrefix(day)}${stagingKey.slice(prefix.length)}`
}

function toSealedRef(
	day: string,
	summary: StagingFileSummary,
): BackupFullFileRef {
	return {
		objectKey: sealedKeyForStagingObject(day, summary.objectKey),
		bytes: summary.bytes,
		sha256: summary.sha256,
	}
}

async function readObjectBytes(
	bucket: R2Bucket,
	key: string,
): Promise<Uint8Array> {
	const object = await bucket.get(key)
	if (object === null) {
		throw new BackupError('staging-object-missing', `missing object ${key}`)
	}
	return new Uint8Array(await object.arrayBuffer())
}

async function verifyStagingFile(
	bucket: R2Bucket,
	summary: StagingFileSummary,
): Promise<Uint8Array> {
	const bytes = await readObjectBytes(bucket, summary.objectKey)
	if (bytes.byteLength !== summary.bytes) {
		throw new BackupError(
			'staging-sha-mismatch',
			`byte count mismatch for ${summary.objectKey}`,
		)
	}
	const digest = await sha256Bytes(bytes)
	if (digest !== summary.sha256) {
		throw new BackupError(
			'staging-sha-mismatch',
			`sha-256 mismatch for ${summary.objectKey}`,
		)
	}
	return bytes
}

async function putImmutableBytes(
	bucket: R2Bucket,
	key: string,
	bytes: Uint8Array,
	contentType: string,
): Promise<void> {
	// A bucket-lock rule rejects puts on existing keys with error 10069
	// before evaluating the conditional, so a partially sealed day (or a
	// duplicate index entry) must fall through to byte comparison instead of
	// failing the whole seal.
	const result = await bucket
		.put(key, bytes, {
			onlyIf: { etagDoesNotMatch: '*' },
			httpMetadata: { contentType },
		})
		.catch((error: unknown) => {
			if (isBucketLockPolicyPutError(error)) return null
			throw error
		})
	if (result !== null) return
	const existing = await bucket.get(key)
	if (existing === null) {
		throw new BackupError(
			'sealed-put-race',
			'sealed object disappeared after immutable put conflict',
			true,
		)
	}
	const existingBytes = new Uint8Array(await existing.arrayBuffer())
	if (
		existingBytes.byteLength !== bytes.byteLength ||
		!existingBytes.every((byte, index) => byte === bytes[index])
	) {
		throw new BackupError(
			'sealed-object-conflict',
			`immutable sealed object differs at ${key}`,
		)
	}
}

async function putImmutableFullManifest(
	bucket: R2Bucket,
	key: string,
	manifest: BackupFullManifest,
): Promise<void> {
	const body = serializeBackupFullManifest(manifest)
	const result = await bucket
		.put(key, body, {
			onlyIf: { etagDoesNotMatch: '*' },
			httpMetadata: { contentType: 'application/json' },
		})
		.catch((error: unknown) => {
			if (isBucketLockPolicyPutError(error)) return null
			throw error
		})
	if (result !== null) return
	const existing = await bucket.get(key)
	if (existing === null) {
		throw new BackupError(
			'full-manifest-put-race',
			'full manifest disappeared after immutable put conflict',
			true,
		)
	}
	if ((await existing.text()) !== body) {
		throw new BackupError(
			'full-manifest-conflict',
			'immutable full manifest differs from this seal result',
		)
	}
}

export async function readFullManifest(
	bucket: R2Bucket,
	key: string,
): Promise<BackupFullManifest | null> {
	const object = await bucket.get(key)
	if (object === null) return null
	try {
		return parseBackupFullManifest(await object.json<unknown>())
	} catch {
		throw new BackupError(
			'full-manifest-corrupt',
			'full backup manifest JSON is corrupt',
		)
	}
}

function collectReferencedBlobHashes(input: {
	r2IndexBodies: Array<string>
	artifactsBody: string
}): Array<string> {
	const hashes: Array<string> = []
	const seen = new Set<string>()
	const push = (hash: string) => {
		if (!sha256Pattern.test(hash) || seen.has(hash)) return
		seen.add(hash)
		hashes.push(hash)
	}
	for (const body of input.r2IndexBodies) {
		for (const line of body.split('\n')) {
			const trimmed = line.trim()
			if (trimmed.length === 0) continue
			let parsed: unknown
			try {
				parsed = JSON.parse(trimmed) as unknown
			} catch {
				throw new BackupError(
					'r2-index-corrupt',
					'r2 index NDJSON line is corrupt',
				)
			}
			if (
				!isRecord(parsed) ||
				typeof parsed.sha256 !== 'string' ||
				!sha256Pattern.test(parsed.sha256)
			) {
				throw new BackupError(
					'r2-index-corrupt',
					'r2 index entry is missing a sha-256',
				)
			}
			push(parsed.sha256)
		}
	}
	let artifacts: unknown
	try {
		artifacts = JSON.parse(input.artifactsBody) as unknown
	} catch {
		throw new BackupError(
			'artifacts-index-corrupt',
			'artifacts index JSON is corrupt',
		)
	}
	if (!isRecord(artifacts) || !Array.isArray(artifacts.entries)) {
		throw new BackupError(
			'artifacts-index-corrupt',
			'artifacts index JSON is corrupt',
		)
	}
	for (const entry of artifacts.entries) {
		if (
			!isRecord(entry) ||
			typeof entry.snapshotSha256 !== 'string' ||
			!sha256Pattern.test(entry.snapshotSha256)
		) {
			throw new BackupError(
				'artifacts-index-corrupt',
				'artifacts index entry is missing snapshotSha256',
			)
		}
		push(entry.snapshotSha256)
	}
	return hashes
}

async function verifyReferencedBlobs(
	bucket: R2Bucket,
	hashes: Array<string>,
): Promise<
	| { kind: 'ok'; blobsVerified: number }
	| { kind: 'missing'; reason: 'blob-missing' }
> {
	// Hashes are already unique from collectReferencedBlobHashes; HEAD every one.
	for (const hash of hashes) {
		const key = backupBlobKey(hash)
		const head = await bucket.head(key)
		if (head === null) {
			return { kind: 'missing', reason: 'blob-missing' }
		}
	}
	return { kind: 'ok', blobsVerified: hashes.length }
}

async function loadVerifiedStagingSummary(
	env: BackupEnvironment,
	day: string,
): Promise<StagingSummary> {
	const object = await env.BACKUP_BUCKET.get(stagingSummaryKey(day))
	if (object === null) {
		throw new BackupError(
			'staging-summary-missing',
			`staging summary missing for ${day}`,
		)
	}
	try {
		const summary = parseStagingSummary(await object.json<unknown>())
		if (summary.day !== day) {
			throw new Error('staging summary day mismatch')
		}
		return summary
	} catch (error) {
		if (error instanceof BackupError) throw error
		throw new BackupError(
			'staging-summary-corrupt',
			`staging summary corrupt for ${day}`,
		)
	}
}

export type SealDayResult =
	| { kind: 'sealed'; day: string; manifestKey: string; alreadySealed: boolean }
	| { kind: 'incomplete'; day: string; reason: string }

export async function sealFullBackupDay(
	env: BackupEnvironment,
	day: string,
	now: Date = new Date(),
): Promise<SealDayResult> {
	assertBackupDay(day)
	const manifestKey = sealedFullManifestKey(day)
	const existing = await readFullManifest(env.BACKUP_BUCKET, manifestKey)
	if (existing !== null) {
		if (!(await verifyBackupFullManifestSignature(env, existing))) {
			throw new BackupError(
				'full-manifest-signature-invalid',
				`existing full manifest signature is invalid for ${day}`,
			)
		}
		if (existing.payload.day !== day) {
			throw new BackupError(
				'full-manifest-day-mismatch',
				`existing full manifest day mismatch for ${day}`,
			)
		}
		safeLog({
			event: 'full-backup-already-sealed',
			status: 'success',
			day,
			manifestKey,
		})
		return { kind: 'sealed', day, manifestKey, alreadySealed: true }
	}

	const d1Payload = backupPayload(env, new Date(`${day}T12:00:00.000Z`))
	const d1Manifest = await readManifest(
		env.BACKUP_BUCKET,
		d1Payload.manifestKey,
	)
	if (d1Manifest === null) {
		return { kind: 'incomplete', day, reason: 'd1-manifest-missing' }
	}
	if (!(await verifyBackupManifestSignature(env, d1Manifest))) {
		throw new BackupError(
			'd1-manifest-signature-invalid',
			`D1 manifest signature invalid for ${day}`,
		)
	}
	const d1ManifestObject = await env.BACKUP_BUCKET.get(d1Payload.manifestKey)
	if (d1ManifestObject === null) {
		return { kind: 'incomplete', day, reason: 'd1-manifest-missing' }
	}
	const d1ManifestBytes = new Uint8Array(await d1ManifestObject.arrayBuffer())
	const d1ManifestSha256 = await sha256Bytes(d1ManifestBytes)

	let summary: StagingSummary
	try {
		summary = await loadVerifiedStagingSummary(env, day)
	} catch (error) {
		if (
			error instanceof BackupError &&
			(error.code === 'staging-summary-missing' ||
				error.code === 'staging-summary-corrupt')
		) {
			return { kind: 'incomplete', day, reason: error.code }
		}
		throw error
	}

	const storageIndexBytes = await verifyStagingFile(
		env.BACKUP_BUCKET,
		summary.storageIndex,
	)
	const storageIndex = parseStorageIndex(
		JSON.parse(new TextDecoder().decode(storageIndexBytes)),
		day,
	)
	for (const entry of storageIndex.entries) {
		const dumpBytes = await verifyStagingFile(env.BACKUP_BUCKET, {
			objectKey: entry.objectKey,
			bytes: entry.bytes,
			sha256: entry.sha256,
		})
		await putImmutableBytes(
			env.BACKUP_BUCKET,
			sealedKeyForStagingObject(day, entry.objectKey),
			dumpBytes,
			'application/x-ndjson',
		)
	}
	await putImmutableBytes(
		env.BACKUP_BUCKET,
		toSealedRef(day, summary.storageIndex).objectKey,
		storageIndexBytes,
		'application/json',
	)

	const sealedR2Indexes: BackupFullManifest['payload']['r2Indexes'] = {}
	const r2IndexBodies: Array<string> = []
	for (const label of backupR2BucketLabels) {
		const fileSummary = summary.r2Indexes[label]
		if (fileSummary === undefined) continue
		const bytes = await verifyStagingFile(env.BACKUP_BUCKET, fileSummary)
		r2IndexBodies.push(new TextDecoder().decode(bytes))
		const sealed = toSealedRef(day, fileSummary)
		await putImmutableBytes(
			env.BACKUP_BUCKET,
			sealed.objectKey,
			bytes,
			'application/x-ndjson',
		)
		sealedR2Indexes[label] = sealed
	}

	const artifactsBytes = await verifyStagingFile(
		env.BACKUP_BUCKET,
		summary.artifactsIndex,
	)
	const sealedArtifacts = toSealedRef(day, summary.artifactsIndex)
	await putImmutableBytes(
		env.BACKUP_BUCKET,
		sealedArtifacts.objectKey,
		artifactsBytes,
		'application/json',
	)

	let blobHashes: Array<string>
	try {
		blobHashes = collectReferencedBlobHashes({
			r2IndexBodies,
			artifactsBody: new TextDecoder().decode(artifactsBytes),
		})
	} catch (error) {
		if (
			error instanceof BackupError &&
			(error.code === 'r2-index-corrupt' ||
				error.code === 'artifacts-index-corrupt')
		) {
			return { kind: 'incomplete', day, reason: error.code }
		}
		throw error
	}
	const blobCheck = await verifyReferencedBlobs(env.BACKUP_BUCKET, blobHashes)
	switch (blobCheck.kind) {
		case 'missing':
			safeLog({
				event: 'full-backup-seal-skipped',
				status: 'failure',
				day,
				errorCode: blobCheck.reason,
			})
			return { kind: 'incomplete', day, reason: blobCheck.reason }
		case 'ok':
			break
		default: {
			const exhaustive: never = blobCheck
			throw exhaustive
		}
	}

	const fullManifest = await signBackupFullManifest(env, {
		day,
		d1ManifestKey: d1Payload.manifestKey,
		d1ManifestSha256,
		storageIndex: toSealedRef(day, summary.storageIndex),
		r2Indexes: sealedR2Indexes,
		artifactsIndex: sealedArtifacts,
		sealedAt: now.toISOString(),
		buildCommit: summary.buildCommit,
	})
	await putImmutableFullManifest(env.BACKUP_BUCKET, manifestKey, fullManifest)
	safeLog({
		event: 'full-backup-sealed',
		status: 'success',
		day,
		manifestKey,
		blobsVerified: blobCheck.blobsVerified,
	})
	return { kind: 'sealed', day, manifestKey, alreadySealed: false }
}

export async function sealRecentCompleteDays(
	env: BackupEnvironment,
	scheduledAt: Date,
	dayCount = 3,
): Promise<void> {
	const errors: Array<unknown> = []
	for (let offset = 0; offset < dayCount; offset += 1) {
		const date = new Date(scheduledAt)
		date.setUTCDate(date.getUTCDate() - offset)
		const day = utcDay(date)
		try {
			const result = await sealFullBackupDay(env, day, scheduledAt)
			switch (result.kind) {
				case 'sealed':
					break
				case 'incomplete':
					safeLog({
						event: 'full-backup-seal-skipped',
						status: 'success',
						day,
						errorCode: result.reason,
					})
					break
				default: {
					const exhaustive: never = result
					throw exhaustive
				}
			}
		} catch (error) {
			safeLog({
				event: 'full-backup-seal-failure',
				status: 'failure',
				day,
				errorCode: errorCode(error),
			})
			errors.push(error)
		}
	}
	if (errors.length === 1) throw errors[0]
	if (errors.length > 1) {
		throw new AggregateError(
			errors,
			'One or more full-backup seal attempts failed.',
		)
	}
}
