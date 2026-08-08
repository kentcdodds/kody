import { canonicalJsonStringify } from './canonical-json.ts'
import { isRecord } from './is-record.ts'

export const backupManifestSchemaVersion = 2 as const
export const backupManifestSignatureAlgorithm = 'Ed25519' as const

export type BackupManifestPayload = {
	schemaVersion: typeof backupManifestSchemaVersion
	source: {
		accountId: string
		databaseId: string
		databaseName: string
	}
	export: {
		bookmark: string
		scheduledAt: string
		startedAt: string
		completedAt: string
	}
	sql: {
		objectKey: string
		bytes: number
		sha256: string
		r2Etag: string
	}
	buildCommit: string
	retentionTier: 'daily' | 'weekly'
	restoreBaseline: {
		id: string
		sha256: string
	}
	signing: {
		algorithm: typeof backupManifestSignatureAlgorithm
		keyId: string
	}
}

export type BackupManifest = {
	schemaVersion: typeof backupManifestSchemaVersion
	payload: BackupManifestPayload
	signature: {
		algorithm: typeof backupManifestSignatureAlgorithm
		keyId: string
		value: string
	}
}

const sha256Pattern = /^[0-9a-f]{64}$/
const keyIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

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

export function parseBackupManifest(value: unknown): BackupManifest {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ['payload', 'schemaVersion', 'signature']) ||
		value.schemaVersion !== backupManifestSchemaVersion ||
		!isRecord(value.payload) ||
		!hasExactKeys(value.payload, [
			'buildCommit',
			'export',
			'restoreBaseline',
			'retentionTier',
			'schemaVersion',
			'signing',
			'source',
			'sql',
		]) ||
		value.payload.schemaVersion !== backupManifestSchemaVersion ||
		!isRecord(value.payload.source) ||
		!hasExactKeys(value.payload.source, [
			'accountId',
			'databaseId',
			'databaseName',
		]) ||
		!isRecord(value.payload.export) ||
		!hasExactKeys(value.payload.export, [
			'bookmark',
			'completedAt',
			'scheduledAt',
			'startedAt',
		]) ||
		!isRecord(value.payload.sql) ||
		!hasExactKeys(value.payload.sql, [
			'bytes',
			'objectKey',
			'r2Etag',
			'sha256',
		]) ||
		!isRecord(value.payload.restoreBaseline) ||
		!hasExactKeys(value.payload.restoreBaseline, ['id', 'sha256']) ||
		!isRecord(value.payload.signing) ||
		!hasExactKeys(value.payload.signing, ['algorithm', 'keyId']) ||
		!isRecord(value.signature) ||
		!hasExactKeys(value.signature, ['algorithm', 'keyId', 'value'])
	) {
		throw new Error('backup manifest has an invalid versioned shape')
	}
	const strings = [
		value.payload.buildCommit,
		value.payload.source.accountId,
		value.payload.source.databaseId,
		value.payload.source.databaseName,
		value.payload.export.bookmark,
		value.payload.sql.objectKey,
		value.payload.sql.r2Etag,
		value.payload.restoreBaseline.id,
	]
	const timestamps = [
		value.payload.export.scheduledAt,
		value.payload.export.startedAt,
		value.payload.export.completedAt,
	]
	if (
		!strings.every(isNonemptyString) ||
		!timestamps.every(
			(timestamp) =>
				typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)),
		) ||
		Date.parse(value.payload.export.scheduledAt as string) >
			Date.parse(value.payload.export.startedAt as string) ||
		Date.parse(value.payload.export.startedAt as string) >
			Date.parse(value.payload.export.completedAt as string) ||
		!Number.isSafeInteger(value.payload.sql.bytes) ||
		Number(value.payload.sql.bytes) <= 0 ||
		typeof value.payload.sql.sha256 !== 'string' ||
		!sha256Pattern.test(value.payload.sql.sha256) ||
		typeof value.payload.restoreBaseline.sha256 !== 'string' ||
		!sha256Pattern.test(value.payload.restoreBaseline.sha256) ||
		(value.payload.retentionTier !== 'daily' &&
			value.payload.retentionTier !== 'weekly') ||
		value.payload.signing.algorithm !== backupManifestSignatureAlgorithm ||
		value.signature.algorithm !== backupManifestSignatureAlgorithm ||
		typeof value.payload.signing.keyId !== 'string' ||
		!keyIdPattern.test(value.payload.signing.keyId) ||
		value.signature.keyId !== value.payload.signing.keyId ||
		typeof value.signature.value !== 'string' ||
		value.signature.value.length === 0
	) {
		throw new Error('backup manifest contains invalid signed values')
	}
	return value as BackupManifest
}

export function canonicalBackupManifestPayload(
	payload: BackupManifestPayload,
): string {
	return canonicalJsonStringify(payload)
}

export function serializeBackupManifest(manifest: BackupManifest): string {
	return `${canonicalJsonStringify(manifest)}\n`
}
