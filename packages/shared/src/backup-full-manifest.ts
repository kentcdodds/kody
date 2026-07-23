import { type BackupR2BucketLabel } from './backup-staging.ts'
import { canonicalJsonStringify } from './canonical-json.ts'

export const backupFullManifestSchemaVersion = 1 as const
export const backupFullManifestSignatureAlgorithm = 'Ed25519' as const

export type BackupFullFileRef = {
	objectKey: string
	bytes: number
	sha256: string
}

export type BackupFullManifestPayload = {
	schemaVersion: typeof backupFullManifestSchemaVersion
	day: string
	d1ManifestKey: string
	d1ManifestSha256: string
	storageIndex: BackupFullFileRef
	r2Indexes: Partial<Record<BackupR2BucketLabel, BackupFullFileRef>>
	artifactsIndex: BackupFullFileRef
	sealedAt: string
	buildCommit: string
	signing: {
		algorithm: typeof backupFullManifestSignatureAlgorithm
		keyId: string
	}
}

export type BackupFullManifest = {
	schemaVersion: typeof backupFullManifestSchemaVersion
	payload: BackupFullManifestPayload
	signature: {
		algorithm: typeof backupFullManifestSignatureAlgorithm
		keyId: string
		value: string
	}
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const sha256Pattern = /^[0-9a-f]{64}$/
const keyIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const knownR2Labels = new Set<string>(['email-blobs', 'community-assets'])

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): boolean {
	const actual = Object.keys(value).sort()
	const sortedExpected = [...expected].sort()
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	)
}

function isNonemptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

function isFileRef(value: unknown): value is BackupFullFileRef {
	return (
		isRecord(value) &&
		hasExactKeys(value, ['bytes', 'objectKey', 'sha256']) &&
		isNonemptyString(value.objectKey) &&
		Number.isSafeInteger(value.bytes) &&
		Number(value.bytes) >= 0 &&
		typeof value.sha256 === 'string' &&
		sha256Pattern.test(value.sha256)
	)
}

function isR2Indexes(
	value: unknown,
): value is Partial<Record<BackupR2BucketLabel, BackupFullFileRef>> {
	if (!isRecord(value)) return false
	for (const [key, entry] of Object.entries(value)) {
		if (!knownR2Labels.has(key) || !isFileRef(entry)) return false
	}
	return true
}

export function parseBackupFullManifest(value: unknown): BackupFullManifest {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ['payload', 'schemaVersion', 'signature']) ||
		value.schemaVersion !== backupFullManifestSchemaVersion ||
		!isRecord(value.payload) ||
		!hasExactKeys(value.payload, [
			'artifactsIndex',
			'buildCommit',
			'd1ManifestKey',
			'd1ManifestSha256',
			'day',
			'r2Indexes',
			'schemaVersion',
			'sealedAt',
			'signing',
			'storageIndex',
		]) ||
		value.payload.schemaVersion !== backupFullManifestSchemaVersion ||
		!isRecord(value.payload.signing) ||
		!hasExactKeys(value.payload.signing, ['algorithm', 'keyId']) ||
		!isRecord(value.signature) ||
		!hasExactKeys(value.signature, ['algorithm', 'keyId', 'value'])
	) {
		throw new Error('full backup manifest has an invalid versioned shape')
	}
	if (
		typeof value.payload.day !== 'string' ||
		!dayPattern.test(value.payload.day) ||
		!isNonemptyString(value.payload.d1ManifestKey) ||
		typeof value.payload.d1ManifestSha256 !== 'string' ||
		!sha256Pattern.test(value.payload.d1ManifestSha256) ||
		!isFileRef(value.payload.storageIndex) ||
		!isR2Indexes(value.payload.r2Indexes) ||
		!isFileRef(value.payload.artifactsIndex) ||
		typeof value.payload.sealedAt !== 'string' ||
		!Number.isFinite(Date.parse(value.payload.sealedAt)) ||
		!isNonemptyString(value.payload.buildCommit) ||
		value.payload.signing.algorithm !== backupFullManifestSignatureAlgorithm ||
		value.signature.algorithm !== backupFullManifestSignatureAlgorithm ||
		typeof value.payload.signing.keyId !== 'string' ||
		!keyIdPattern.test(value.payload.signing.keyId) ||
		value.signature.keyId !== value.payload.signing.keyId ||
		typeof value.signature.value !== 'string' ||
		value.signature.value.length === 0
	) {
		throw new Error('full backup manifest contains invalid signed values')
	}
	return value as BackupFullManifest
}

export function canonicalBackupFullManifestPayload(
	payload: BackupFullManifestPayload,
): string {
	return canonicalJsonStringify(payload)
}

export function serializeBackupFullManifest(
	manifest: BackupFullManifest,
): string {
	return `${canonicalJsonStringify(manifest)}\n`
}
