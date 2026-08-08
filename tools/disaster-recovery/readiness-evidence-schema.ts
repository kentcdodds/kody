import { isRecord } from '@kody-internal/shared/is-record.ts'

import { canonicalJson } from './canonical-json.ts'
import {
	type EvidenceDetailsByKind,
	type EvidenceKind,
	type SignedEvidenceEnvelope,
	canonicalContracts,
	maximumSupportedD1BackupBytes,
} from './readiness-contracts.ts'
import {
	base64Pattern,
	cloudflareAccountIdPattern,
	exactKeys,
	isIsoDate,
	isNonemptyString,
	isNonnegativeInteger,
	isPositiveInteger,
	parseIdentity,
	sha256Pattern,
	uuidPattern,
} from './readiness-validation.ts'

const resourceIds = new Set<string>(
	canonicalContracts.map((contract) => contract.id),
)
const evidenceKinds = new Set<string>(
	canonicalContracts.flatMap((contract) => contract.requiredEvidenceKinds),
)
const lowerKebabIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function parseDetails<K extends EvidenceKind>(
	kind: K,
	value: unknown,
): EvidenceDetailsByKind[K] | undefined {
	if (!isRecord(value)) return undefined
	switch (kind) {
		case 'alarm-rebuild-drill':
			if (
				exactKeys(value, ['alarmsRebuilt', 'deliveryVerified']) &&
				isNonnegativeInteger(value.alarmsRebuilt) &&
				value.deliveryVerified === true
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'artifact-mirror-verification':
			if (
				exactKeys(value, ['mirrorSha256', 'refCount']) &&
				typeof value.mirrorSha256 === 'string' &&
				sha256Pattern.test(value.mirrorSha256) &&
				isNonnegativeInteger(value.refCount)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'bundle-kv-rebuild-drill':
			if (
				exactKeys(value, ['contentSha256', 'keyCount']) &&
				typeof value.contentSha256 === 'string' &&
				sha256Pattern.test(value.contentSha256) &&
				isNonnegativeInteger(value.keyCount)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'community-icon-rebuild-drill':
			if (
				exactKeys(value, ['contentSha256', 'objectCount']) &&
				typeof value.contentSha256 === 'string' &&
				sha256Pattern.test(value.contentSha256) &&
				isNonnegativeInteger(value.objectCount)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'contract-verification':
			if (
				exactKeys(value, ['checksPassed', 'contractVersion']) &&
				isPositiveInteger(value.checksPassed) &&
				isNonemptyString(value.contractVersion)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'destination-credential-check':
		case 'source-credential-check':
			if (
				exactKeys(value, ['credentialId', 'scope']) &&
				isNonemptyString(value.credentialId) &&
				isNonemptyString(value.scope)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'd1-restore-drill':
			if (
				exactKeys(value, [
					'backupManifestSha256',
					'foreignKeyViolations',
					'isolationBaselineSha256',
					'migrationSetSha256',
					'quickCheck',
					'restoredDatabaseUuid',
					'schemaSha256',
					'sourceBookmark',
					'sourceDatabaseName',
					'sqlSha256',
					'trustedBaselineId',
					'trustedBaselineSha256',
				]) &&
				typeof value.backupManifestSha256 === 'string' &&
				sha256Pattern.test(value.backupManifestSha256) &&
				value.foreignKeyViolations === 0 &&
				typeof value.isolationBaselineSha256 === 'string' &&
				sha256Pattern.test(value.isolationBaselineSha256) &&
				typeof value.migrationSetSha256 === 'string' &&
				sha256Pattern.test(value.migrationSetSha256) &&
				value.quickCheck === 'ok' &&
				typeof value.restoredDatabaseUuid === 'string' &&
				uuidPattern.test(value.restoredDatabaseUuid) &&
				typeof value.schemaSha256 === 'string' &&
				sha256Pattern.test(value.schemaSha256) &&
				isNonemptyString(value.sourceBookmark) &&
				isNonemptyString(value.sourceDatabaseName) &&
				typeof value.sqlSha256 === 'string' &&
				sha256Pattern.test(value.sqlSha256) &&
				typeof value.trustedBaselineId === 'string' &&
				lowerKebabIdPattern.test(value.trustedBaselineId) &&
				typeof value.trustedBaselineSha256 === 'string' &&
				sha256Pattern.test(value.trustedBaselineSha256)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'd1-size-ceiling-check':
			if (
				exactKeys(value, [
					'backupManifestSha256',
					'ceilingBytes',
					'isolationBaselineSha256',
					'measuredBytes',
					'migrationSetSha256',
					'monitoredAt',
					'schemaSha256',
					'sourceAccountId',
					'sourceBookmark',
					'sourceDatabaseName',
					'sourceDatabaseUuid',
					'sqlSha256',
					'trustedBaselineId',
					'trustedBaselineSha256',
				]) &&
				typeof value.backupManifestSha256 === 'string' &&
				sha256Pattern.test(value.backupManifestSha256) &&
				isPositiveInteger(value.ceilingBytes) &&
				typeof value.isolationBaselineSha256 === 'string' &&
				sha256Pattern.test(value.isolationBaselineSha256) &&
				isPositiveInteger(value.measuredBytes) &&
				typeof value.migrationSetSha256 === 'string' &&
				sha256Pattern.test(value.migrationSetSha256) &&
				value.ceilingBytes <= maximumSupportedD1BackupBytes &&
				value.measuredBytes < value.ceilingBytes &&
				isIsoDate(value.monitoredAt) &&
				typeof value.schemaSha256 === 'string' &&
				sha256Pattern.test(value.schemaSha256) &&
				isNonemptyString(value.sourceAccountId) &&
				isNonemptyString(value.sourceBookmark) &&
				isNonemptyString(value.sourceDatabaseName) &&
				typeof value.sourceDatabaseUuid === 'string' &&
				uuidPattern.test(value.sourceDatabaseUuid) &&
				typeof value.sqlSha256 === 'string' &&
				sha256Pattern.test(value.sqlSha256) &&
				typeof value.trustedBaselineId === 'string' &&
				lowerKebabIdPattern.test(value.trustedBaselineId) &&
				typeof value.trustedBaselineSha256 === 'string' &&
				sha256Pattern.test(value.trustedBaselineSha256)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'escrow-recovery-drill':
			if (
				exactKeys(value, ['custodian', 'recoveredFingerprint']) &&
				isNonemptyString(value.custodian) &&
				isNonemptyString(value.recoveredFingerprint)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'inventory':
			if (
				exactKeys(value, ['inventorySha256', 'itemCount']) &&
				typeof value.inventorySha256 === 'string' &&
				sha256Pattern.test(value.inventorySha256) &&
				isNonnegativeInteger(value.itemCount)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'key-fingerprint':
			if (
				exactKeys(value, [
					'destinationFingerprint',
					'matched',
					'sourceFingerprint',
				]) &&
				isNonemptyString(value.destinationFingerprint) &&
				value.matched === true &&
				isNonemptyString(value.sourceFingerprint) &&
				value.destinationFingerprint === value.sourceFingerprint
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'oauth-reauthorization-drill':
			if (
				exactKeys(value, ['connectorCount', 'reauthorizedCount']) &&
				isNonnegativeInteger(value.connectorCount) &&
				isNonnegativeInteger(value.reauthorizedCount) &&
				value.reauthorizedCount === value.connectorCount
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'queue-workflow-rebuild-drill':
			if (
				exactKeys(value, ['deliveryVerified', 'queueCount', 'workflowCount']) &&
				value.deliveryVerified === true &&
				isNonnegativeInteger(value.queueCount) &&
				isNonnegativeInteger(value.workflowCount)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'r2-round-trip-drill':
			if (
				exactKeys(value, ['bytes', 'objectKey', 'sha256']) &&
				isNonnegativeInteger(value.bytes) &&
				isNonemptyString(value.objectKey) &&
				typeof value.sha256 === 'string' &&
				sha256Pattern.test(value.sha256)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'storage-runner-round-trip-drill':
			if (
				exactKeys(value, ['instanceCount', 'kvEntries', 'sqliteRows']) &&
				isNonnegativeInteger(value.instanceCount) &&
				isNonnegativeInteger(value.kvEntries) &&
				isNonnegativeInteger(value.sqliteRows)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'transfer-support-check':
			if (
				exactKeys(value, ['mechanism', 'supported']) &&
				isNonemptyString(value.mechanism) &&
				value.supported === true
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'vectorize-rebuild-drill':
			if (
				exactKeys(value, ['queryVerified', 'vectorCount']) &&
				value.queryVerified === true &&
				isNonnegativeInteger(value.vectorCount)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		default: {
			const exhaustive: never = kind
			throw new Error(String(exhaustive))
		}
	}
}

function destinationIsRequired(kind: EvidenceKind): boolean {
	switch (kind) {
		case 'inventory':
		case 'source-credential-check':
		case 'd1-size-ceiling-check':
			return false
		case 'alarm-rebuild-drill':
		case 'artifact-mirror-verification':
		case 'bundle-kv-rebuild-drill':
		case 'community-icon-rebuild-drill':
		case 'contract-verification':
		case 'destination-credential-check':
		case 'd1-restore-drill':
		case 'escrow-recovery-drill':
		case 'key-fingerprint':
		case 'oauth-reauthorization-drill':
		case 'queue-workflow-rebuild-drill':
		case 'r2-round-trip-drill':
		case 'storage-runner-round-trip-drill':
		case 'transfer-support-check':
		case 'vectorize-rebuild-drill':
			return true
		default: {
			const exhaustive: never = kind
			throw new Error(String(exhaustive))
		}
	}
}

export function parseSignedEvidenceEnvelope(
	input: unknown,
): SignedEvidenceEnvelope | undefined {
	if (
		!isRecord(input) ||
		!exactKeys(input, ['content', 'schemaVersion', 'signature']) ||
		input.schemaVersion !== 1 ||
		!isRecord(input.content) ||
		!exactKeys(input.content, [
			'changeId',
			'destinationIdentity',
			'details',
			'expiresAt',
			'kind',
			'outcome',
			'performedAt',
			'resourceId',
			'sourceIdentity',
			'systemVersion',
			'uri',
			'verifierIdentity',
		]) ||
		typeof input.content.kind !== 'string' ||
		!evidenceKinds.has(input.content.kind) ||
		typeof input.content.resourceId !== 'string' ||
		!resourceIds.has(input.content.resourceId) ||
		input.content.outcome !== 'passed' ||
		!isNonemptyString(input.content.uri) ||
		!isNonemptyString(input.content.verifierIdentity) ||
		!isNonemptyString(input.content.changeId) ||
		!isNonemptyString(input.content.systemVersion) ||
		!isIsoDate(input.content.performedAt) ||
		!isIsoDate(input.content.expiresAt) ||
		Date.parse(input.content.expiresAt) <= Date.parse(input.content.performedAt)
	) {
		return undefined
	}
	const kind = input.content.kind as EvidenceKind
	const sourceIdentity = parseIdentity(input.content.sourceIdentity)
	const destinationIdentity =
		input.content.destinationIdentity === null
			? null
			: parseIdentity(input.content.destinationIdentity)
	const details = parseDetails(kind, input.content.details)
	if (
		!sourceIdentity ||
		destinationIdentity === undefined ||
		(input.content.resourceId === 'APP_DB' &&
			(!cloudflareAccountIdPattern.test(sourceIdentity.accountId) ||
				(destinationIdentity !== null &&
					!cloudflareAccountIdPattern.test(destinationIdentity.accountId)))) ||
		(destinationIsRequired(kind)
			? destinationIdentity === null
			: destinationIdentity !== null) ||
		!details ||
		!isRecord(input.signature) ||
		!exactKeys(input.signature, ['algorithm', 'keyId', 'value']) ||
		input.signature.algorithm !== 'Ed25519' ||
		!isNonemptyString(input.signature.keyId) ||
		typeof input.signature.value !== 'string' ||
		!base64Pattern.test(input.signature.value) ||
		Buffer.from(input.signature.value, 'base64').byteLength !== 64
	) {
		return undefined
	}
	if (kind === 'd1-size-ceiling-check') {
		const sizeDetails =
			details as EvidenceDetailsByKind['d1-size-ceiling-check']
		if (
			sizeDetails.sourceAccountId !== sourceIdentity.accountId ||
			sizeDetails.sourceDatabaseUuid !== sourceIdentity.resourceId ||
			sizeDetails.monitoredAt !== input.content.performedAt
		) {
			return undefined
		}
	}
	if (kind === 'd1-restore-drill') {
		const restoreDetails = details as EvidenceDetailsByKind['d1-restore-drill']
		if (
			destinationIdentity === null ||
			restoreDetails.restoredDatabaseUuid.toLowerCase() !==
				destinationIdentity.resourceId.toLowerCase() ||
			sourceIdentity.accountId.toLowerCase() ===
				destinationIdentity.accountId.toLowerCase() ||
			sourceIdentity.resourceId.toLowerCase() ===
				destinationIdentity.resourceId.toLowerCase()
		) {
			return undefined
		}
	}
	return input as SignedEvidenceEnvelope
}

export function canonicalEvidencePayload(
	envelope: Pick<SignedEvidenceEnvelope, 'schemaVersion' | 'content'>,
): string {
	return canonicalJson({
		schemaVersion: envelope.schemaVersion,
		content: envelope.content,
	})
}
