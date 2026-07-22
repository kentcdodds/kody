import { canonicalJson } from './canonical-json.ts'

const sha256Pattern = /^[a-f0-9]{64}$/
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const base64Pattern =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const millisecondsPerDay = 24 * 60 * 60 * 1000
export const maximumSupportedD1BackupBytes = 4_500_000_000

export type ReadinessLevel = 'd1-only' | 'canonical-data' | 'full-service'

export type CanonicalResourceId =
	| 'ALARMS'
	| 'APP_DB'
	| 'ARTIFACTS'
	| 'BUNDLE_ARTIFACTS_KV'
	| 'COMMUNITY_ASSETS'
	| 'COMMUNITY_ICONS'
	| 'EMAIL_BLOBS'
	| 'OAUTH'
	| 'QUEUES_WORKFLOWS'
	| 'SECRET_STORE_KEY'
	| 'STORAGE_RUNNER'
	| 'VECTORIZE'

export type EvidenceKind =
	| 'alarm-rebuild-drill'
	| 'artifact-mirror-verification'
	| 'bundle-kv-rebuild-drill'
	| 'community-icon-rebuild-drill'
	| 'contract-verification'
	| 'destination-credential-check'
	| 'd1-restore-drill'
	| 'd1-size-ceiling-check'
	| 'escrow-recovery-drill'
	| 'inventory'
	| 'key-fingerprint'
	| 'oauth-reauthorization-drill'
	| 'queue-workflow-rebuild-drill'
	| 'r2-round-trip-drill'
	| 'source-credential-check'
	| 'storage-runner-round-trip-drill'
	| 'transfer-support-check'
	| 'vectorize-rebuild-drill'

export type ResourceIdentity = {
	accountId: string
	resourceId: string
}

export type EvidenceDetailsByKind = {
	'alarm-rebuild-drill': { alarmsRebuilt: number; deliveryVerified: true }
	'artifact-mirror-verification': { mirrorSha256: string; refCount: number }
	'bundle-kv-rebuild-drill': { contentSha256: string; keyCount: number }
	'community-icon-rebuild-drill': {
		contentSha256: string
		objectCount: number
	}
	'contract-verification': { checksPassed: number; contractVersion: string }
	'destination-credential-check': { credentialId: string; scope: string }
	'd1-restore-drill': {
		foreignKeyViolations: 0
		quickCheck: 'ok'
		restoredDatabaseUuid: string
	}
	'd1-size-ceiling-check': {
		ceilingBytes: number
		measuredBytes: number
		monitoredAt: string
		sourceAccountId: string
		sourceDatabaseUuid: string
	}
	'escrow-recovery-drill': {
		custodian: string
		recoveredFingerprint: string
	}
	inventory: { inventorySha256: string; itemCount: number }
	'key-fingerprint': {
		destinationFingerprint: string
		matched: true
		sourceFingerprint: string
	}
	'oauth-reauthorization-drill': {
		connectorCount: number
		reauthorizedCount: number
	}
	'queue-workflow-rebuild-drill': {
		deliveryVerified: true
		queueCount: number
		workflowCount: number
	}
	'r2-round-trip-drill': { bytes: number; objectKey: string; sha256: string }
	'source-credential-check': { credentialId: string; scope: string }
	'storage-runner-round-trip-drill': {
		instanceCount: number
		kvEntries: number
		sqliteRows: number
	}
	'transfer-support-check': { mechanism: string; supported: true }
	'vectorize-rebuild-drill': { queryVerified: true; vectorCount: number }
}

export type EvidenceContent<K extends EvidenceKind = EvidenceKind> = {
	changeId: string
	destinationIdentity: ResourceIdentity | null
	details: EvidenceDetailsByKind[K]
	kind: K
	outcome: 'passed'
	performedAt: string
	resourceId: CanonicalResourceId
	sourceIdentity: ResourceIdentity
	systemVersion: string
	uri: string
	verifierIdentity: string
}

export type SignedEvidenceEnvelope<K extends EvidenceKind = EvidenceKind> = {
	schemaVersion: 1
	content: EvidenceContent<K>
	signature: {
		algorithm: 'Ed25519'
		keyId: string
		value: string
	}
}

export type EvidenceArtifact = {
	changeId: string
	destinationIdentity: ResourceIdentity | null
	kind: EvidenceKind
	outcome: 'passed'
	performedAt: string
	sourceIdentity: ResourceIdentity
	systemVersion: string
	type: string
	uri: string
	sha256: string
	verifierIdentity: string
}

export type ResourceEvidence = {
	schemaVersion: 1
	resourceId: CanonicalResourceId
	verifierIdentity: string
	changeId: string
	systemVersion: string
	performedAt: string
	expiresAt: string
	artifacts: Array<EvidenceArtifact>
}

type ParsedEvidenceArtifact = Required<EvidenceArtifact>

type ParsedResourceEvidence = {
	schemaVersion: 1
	resourceId: CanonicalResourceId
	verifierIdentity: string
	changeId: string
	systemVersion: string
	performedAt: string
	expiresAt: string
	artifacts: Array<ParsedEvidenceArtifact>
}

export type VerifiedEvidenceArtifact = {
	digest: string
	envelope: SignedEvidenceEnvelope
}

export type ResourceContract = {
	id: CanonicalResourceId
	requiredFor: ReadinessLevel
	transfer:
		| 'd1-logical-import'
		| 'derived-data-rebuild'
		| 'git-mirror'
		| 'oauth-reauthorization'
		| 'operational-rebuild'
		| 'r2-object-copy'
		| 'secret-fingerprint-escrow'
		| 'storage-runner-export'
	requiredEvidenceKinds: ReadonlyArray<EvidenceKind>
	includes: ReadonlyArray<string>
	excludes: ReadonlyArray<string>
}

const commonEvidenceKinds = [
	'inventory',
	'source-credential-check',
	'destination-credential-check',
	'transfer-support-check',
	'contract-verification',
] as const satisfies ReadonlyArray<EvidenceKind>

export const canonicalContracts = [
	{
		id: 'APP_DB',
		requiredFor: 'd1-only',
		transfer: 'd1-logical-import',
		requiredEvidenceKinds: [
			...commonEvidenceKinds,
			'd1-size-ceiling-check',
			'd1-restore-drill',
		],
		includes: [
			'complete checksummed D1 SQL export',
			'migration and sqlite schema parity evidence',
			'foreign-key, integrity, sequence, and two-user isolation evidence',
		],
		excludes: ['production overwrite', 'Time Travel', 'automatic cutover'],
	},
	{
		id: 'EMAIL_BLOBS',
		requiredFor: 'canonical-data',
		transfer: 'r2-object-copy',
		requiredEvidenceKinds: [...commonEvidenceKinds, 'r2-round-trip-drill'],
		includes: [
			'all raw MIME objects byte-for-byte with keys and metadata',
			'all attachment objects byte-for-byte with keys and metadata',
		],
		excludes: ['parsed email rows as a substitute for raw MIME or attachments'],
	},
	{
		id: 'COMMUNITY_ASSETS',
		requiredFor: 'canonical-data',
		transfer: 'r2-object-copy',
		requiredEvidenceKinds: [...commonEvidenceKinds, 'r2-round-trip-drill'],
		includes: ['all user-uploaded avatar objects with keys and metadata'],
		excludes: ['derived package icons', 'regenerable derived assets'],
	},
	{
		id: 'STORAGE_RUNNER',
		requiredFor: 'canonical-data',
		transfer: 'storage-runner-export',
		requiredEvidenceKinds: [
			...commonEvidenceKinds,
			'storage-runner-round-trip-drill',
		],
		includes: [
			'complete known-instance inventory',
			'per known instance KV keys, values, metadata, and expiration',
			'per known instance SQLite schema and row data',
			'round-trip verification for both KV and SQLite representations',
		],
		excludes: [
			'claim that generic SQL enumerates unknown Durable Object instances',
			'claim that generic SQL preserves runtime or alarm state',
		],
	},
	{
		id: 'ARTIFACTS',
		requiredFor: 'canonical-data',
		transfer: 'git-mirror',
		requiredEvidenceKinds: [
			...commonEvidenceKinds,
			'artifact-mirror-verification',
		],
		includes: ['mirror clone containing every ref and complete Git history'],
		excludes: ['default-branch-only clone', 'working tree as history coverage'],
	},
	{
		id: 'SECRET_STORE_KEY',
		requiredFor: 'canonical-data',
		transfer: 'secret-fingerprint-escrow',
		requiredEvidenceKinds: [
			...commonEvidenceKinds,
			'key-fingerprint',
			'escrow-recovery-drill',
		],
		includes: [
			'external source and destination fingerprint evidence',
			'operator-confirmed fingerprint match',
			'external escrow custody and recovery-test evidence',
		],
		excludes: [
			'secret key material in manifests, logs, or reports',
			'claiming D1 secret ciphertext is usable without the matching key',
		],
	},
	{
		id: 'VECTORIZE',
		requiredFor: 'full-service',
		transfer: 'derived-data-rebuild',
		requiredEvidenceKinds: [...commonEvidenceKinds, 'vectorize-rebuild-drill'],
		includes: [
			'complete index inventory and configuration',
			'rebuild procedure from canonical per-user source data',
			'post-rebuild user-scoped query verification',
		],
		excludes: ['claiming an empty or partially rebuilt index is service-ready'],
	},
	{
		id: 'BUNDLE_ARTIFACTS_KV',
		requiredFor: 'full-service',
		transfer: 'derived-data-rebuild',
		requiredEvidenceKinds: [...commonEvidenceKinds, 'bundle-kv-rebuild-drill'],
		includes: [
			'destination namespace inventory and credentials',
			'rebuild procedure from canonical artifact Git mirrors',
			'key and content verification after rebuild',
		],
		excludes: ['treating derived bundle cache as canonical source data'],
	},
	{
		id: 'COMMUNITY_ICONS',
		requiredFor: 'full-service',
		transfer: 'derived-data-rebuild',
		requiredEvidenceKinds: [
			...commonEvidenceKinds,
			'community-icon-rebuild-drill',
		],
		includes: [
			'icon derivation inventory and deterministic rebuild procedure',
			'post-rebuild object verification',
		],
		excludes: ['treating derived icons as user-uploaded avatar assets'],
	},
	{
		id: 'ALARMS',
		requiredFor: 'full-service',
		transfer: 'operational-rebuild',
		requiredEvidenceKinds: [...commonEvidenceKinds, 'alarm-rebuild-drill'],
		includes: [
			'complete known-instance alarm inventory',
			'alarm re-registration procedure and schedule verification',
		],
		excludes: ['claiming generic SQL preserves Durable Object alarm state'],
	},
	{
		id: 'QUEUES_WORKFLOWS',
		requiredFor: 'full-service',
		transfer: 'operational-rebuild',
		requiredEvidenceKinds: [
			...commonEvidenceKinds,
			'queue-workflow-rebuild-drill',
		],
		includes: [
			'queue, consumer, dead-letter, and workflow configuration inventory',
			'destination provisioning credentials and replay/runbook evidence',
			'post-rebuild delivery and workflow execution verification',
		],
		excludes: [
			'claiming in-flight messages are covered without explicit evidence',
			'claiming active workflow instances are recreated from configuration',
		],
	},
	{
		id: 'OAUTH',
		requiredFor: 'full-service',
		transfer: 'oauth-reauthorization',
		requiredEvidenceKinds: [
			...commonEvidenceKinds,
			'oauth-reauthorization-drill',
		],
		includes: [
			'per-user connector inventory',
			'post-restore user reauthorization',
		],
		excludes: ['copying access tokens', 'copying refresh tokens'],
	},
] as const satisfies ReadonlyArray<ResourceContract>

export type ReadinessResult = {
	levels: Record<ReadinessLevel, { ready: boolean; failures: Array<string> }>
	resources: Array<{
		contract: ResourceContract
		evidence?: ResourceEvidence
		failures: Array<string>
	}>
	inputFailures: Array<string>
}

const resourceIds = new Set<string>(
	canonicalContracts.map((contract) => contract.id),
)
const evidenceKinds = new Set<string>(
	canonicalContracts.flatMap((contract) => contract.requiredEvidenceKinds),
)
const levelOrder: Record<ReadinessLevel, number> = {
	'd1-only': 0,
	'canonical-data': 1,
	'full-service': 2,
}
export const maximumEvidenceAgeDays = {
	'd1-only': 35,
	'canonical-data': 100,
	'full-service': 200,
} as const satisfies Record<ReadinessLevel, number>

function exactKeys(
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonemptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

function isIsoDate(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		isoDatePattern.test(value) &&
		Number.isFinite(Date.parse(value))
	)
}

function isNonnegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0
}

function parseIdentity(value: unknown): ResourceIdentity | undefined {
	if (
		!isRecord(value) ||
		!exactKeys(value, ['accountId', 'resourceId']) ||
		!isNonemptyString(value.accountId) ||
		!isNonemptyString(value.resourceId)
	) {
		return undefined
	}
	return { accountId: value.accountId, resourceId: value.resourceId }
}

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
					'foreignKeyViolations',
					'quickCheck',
					'restoredDatabaseUuid',
				]) &&
				value.foreignKeyViolations === 0 &&
				value.quickCheck === 'ok' &&
				typeof value.restoredDatabaseUuid === 'string' &&
				uuidPattern.test(value.restoredDatabaseUuid)
			) {
				return value as EvidenceDetailsByKind[K]
			}
			return undefined
		case 'd1-size-ceiling-check':
			if (
				exactKeys(value, [
					'ceilingBytes',
					'measuredBytes',
					'monitoredAt',
					'sourceAccountId',
					'sourceDatabaseUuid',
				]) &&
				isPositiveInteger(value.ceilingBytes) &&
				isNonnegativeInteger(value.measuredBytes) &&
				value.ceilingBytes <= maximumSupportedD1BackupBytes &&
				value.measuredBytes < value.ceilingBytes &&
				isIsoDate(value.monitoredAt) &&
				isNonemptyString(value.sourceAccountId) &&
				typeof value.sourceDatabaseUuid === 'string' &&
				uuidPattern.test(value.sourceDatabaseUuid)
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
		!isIsoDate(input.content.performedAt)
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

function parseEvidence(
	input: unknown,
	now: Date,
): { evidence: Array<ParsedResourceEvidence>; failures: Array<string> } {
	if (!Array.isArray(input)) {
		return { evidence: [], failures: ['evidence input must be an array'] }
	}
	if (!Number.isFinite(now.getTime())) {
		return { evidence: [], failures: ['readiness clock is invalid'] }
	}
	const parsed: Array<ParsedResourceEvidence> = []
	const failures: Array<string> = []
	const seenResources = new Set<string>()
	const seenUris = new Set<string>()
	for (const [index, candidate] of input.entries()) {
		const label = `evidence[${String(index)}]`
		if (
			!isRecord(candidate) ||
			!exactKeys(candidate, [
				'artifacts',
				'changeId',
				'expiresAt',
				'performedAt',
				'resourceId',
				'schemaVersion',
				'systemVersion',
				'verifierIdentity',
			]) ||
			candidate.schemaVersion !== 1
		) {
			failures.push(`${label}: invalid versioned shape`)
			continue
		}
		const resourceId = candidate.resourceId
		if (typeof resourceId !== 'string' || !resourceIds.has(resourceId)) {
			failures.push(`${label}: unknown resourceId`)
			continue
		}
		if (seenResources.has(resourceId)) {
			failures.push(`${label}: duplicate resourceId ${resourceId}`)
			continue
		}
		seenResources.add(resourceId)
		if (
			!isNonemptyString(candidate.verifierIdentity) ||
			!isNonemptyString(candidate.changeId) ||
			!isNonemptyString(candidate.systemVersion)
		) {
			failures.push(
				`${label}: verifier identity, change ID, and system version are required`,
			)
			continue
		}
		if (!isIsoDate(candidate.performedAt) || !isIsoDate(candidate.expiresAt)) {
			failures.push(`${label}: performedAt and expiresAt are required`)
			continue
		}
		const performedAt = Date.parse(candidate.performedAt)
		const expiresAt = Date.parse(candidate.expiresAt)
		if (performedAt > now.getTime()) {
			failures.push(`${label}: performedAt is in the future`)
			continue
		}
		const contract = canonicalContracts.find(
			(candidateContract) => candidateContract.id === resourceId,
		)
		if (!contract) {
			failures.push(`${label}: resource contract is unavailable`)
			continue
		}
		const maximumAgeDays = maximumEvidenceAgeDays[contract.requiredFor]
		if (now.getTime() - performedAt > maximumAgeDays * millisecondsPerDay) {
			failures.push(
				`${label}: evidence exceeds the code-owned ${String(maximumAgeDays)}-day maximum age for ${contract.requiredFor}`,
			)
			continue
		}
		if (expiresAt <= now.getTime() || expiresAt <= performedAt) {
			failures.push(`${label}: attestation is expired or has invalid freshness`)
			continue
		}
		if (
			!Array.isArray(candidate.artifacts) ||
			candidate.artifacts.length === 0
		) {
			failures.push(`${label}: artifacts must be a nonempty array`)
			continue
		}
		const artifacts: Array<ParsedEvidenceArtifact> = []
		const seenKinds = new Set<string>()
		let resourceSourceIdentity: ResourceIdentity | null = null
		let resourceDestinationIdentity: ResourceIdentity | null = null
		let artifactMalformed = false
		for (const [artifactIndex, artifact] of candidate.artifacts.entries()) {
			const artifactLabel = `${label}.artifacts[${String(artifactIndex)}]`
			if (
				!isRecord(artifact) ||
				!exactKeys(artifact, [
					'changeId',
					'destinationIdentity',
					'kind',
					'outcome',
					'performedAt',
					'sha256',
					'sourceIdentity',
					'systemVersion',
					'type',
					'uri',
					'verifierIdentity',
				]) ||
				typeof artifact.kind !== 'string' ||
				!evidenceKinds.has(artifact.kind) ||
				artifact.type !== 'application/vnd.kody.readiness-evidence+json' ||
				!isNonemptyString(artifact.uri) ||
				typeof artifact.sha256 !== 'string' ||
				!sha256Pattern.test(artifact.sha256) ||
				artifact.outcome !== 'passed' ||
				!isNonemptyString(artifact.verifierIdentity) ||
				!isNonemptyString(artifact.changeId) ||
				!isNonemptyString(artifact.systemVersion) ||
				!isIsoDate(artifact.performedAt)
			) {
				failures.push(`${artifactLabel}: invalid signed-evidence metadata`)
				artifactMalformed = true
				continue
			}
			if (seenKinds.has(artifact.kind)) {
				failures.push(`${artifactLabel}: duplicate evidence kind`)
				artifactMalformed = true
				continue
			}
			seenKinds.add(artifact.kind)
			if (seenUris.has(artifact.uri)) {
				failures.push(
					`${artifactLabel}: duplicate artifact URI ${artifact.uri}`,
				)
				artifactMalformed = true
				continue
			}
			seenUris.add(artifact.uri)
			const sourceIdentity = parseIdentity(artifact.sourceIdentity)
			const destinationIdentity =
				artifact.destinationIdentity === null
					? null
					: parseIdentity(artifact.destinationIdentity)
			if (
				!sourceIdentity ||
				destinationIdentity === undefined ||
				artifact.verifierIdentity !== candidate.verifierIdentity ||
				artifact.changeId !== candidate.changeId ||
				artifact.systemVersion !== candidate.systemVersion ||
				artifact.performedAt !== candidate.performedAt
			) {
				failures.push(`${artifactLabel}: metadata does not match its index`)
				artifactMalformed = true
				continue
			}
			if (resourceSourceIdentity === null) {
				resourceSourceIdentity = sourceIdentity
			} else if (!identitiesEqual(resourceSourceIdentity, sourceIdentity)) {
				failures.push(
					`${artifactLabel}: source identity differs across resource evidence`,
				)
				artifactMalformed = true
				continue
			}
			if (destinationIdentity !== null) {
				if (resourceDestinationIdentity === null) {
					resourceDestinationIdentity = destinationIdentity
				} else if (
					!identitiesEqual(resourceDestinationIdentity, destinationIdentity)
				) {
					failures.push(
						`${artifactLabel}: destination identity differs across resource evidence`,
					)
					artifactMalformed = true
					continue
				}
			}
			artifacts.push(artifact as ParsedEvidenceArtifact)
		}
		if (!artifactMalformed) {
			parsed.push({
				schemaVersion: 1,
				resourceId: resourceId as CanonicalResourceId,
				verifierIdentity: candidate.verifierIdentity,
				changeId: candidate.changeId,
				systemVersion: candidate.systemVersion,
				performedAt: candidate.performedAt,
				expiresAt: candidate.expiresAt,
				artifacts,
			})
		}
	}
	return { evidence: parsed, failures }
}

function isRequiredAtLevel(
	requiredFor: ReadinessLevel,
	level: ReadinessLevel,
): boolean {
	return levelOrder[requiredFor] <= levelOrder[level]
}

function identitiesEqual(
	left: ResourceIdentity | null,
	right: ResourceIdentity | null,
): boolean {
	return (
		left === right ||
		(left !== null &&
			right !== null &&
			left.accountId === right.accountId &&
			left.resourceId === right.resourceId)
	)
}

function artifactMatchesEnvelope(
	resourceId: CanonicalResourceId,
	artifact: ParsedEvidenceArtifact,
	envelope: SignedEvidenceEnvelope,
): boolean {
	const content = envelope.content
	const metadataMatches =
		content.resourceId === resourceId &&
		content.kind === artifact.kind &&
		content.uri === artifact.uri &&
		identitiesEqual(content.sourceIdentity, artifact.sourceIdentity) &&
		identitiesEqual(
			content.destinationIdentity,
			artifact.destinationIdentity,
		) &&
		content.outcome === artifact.outcome &&
		content.verifierIdentity === artifact.verifierIdentity &&
		content.changeId === artifact.changeId &&
		content.systemVersion === artifact.systemVersion &&
		content.performedAt === artifact.performedAt
	if (!metadataMatches) return false
	if (
		resourceId === 'APP_DB' &&
		(content.kind === 'source-credential-check' ||
			content.kind === 'destination-credential-check')
	) {
		const details = content.details as EvidenceDetailsByKind[
			| 'source-credential-check'
			| 'destination-credential-check']
		return details.scope === 'Account D1 Edit'
	}
	return true
}

export function assessCanonicalReadiness(
	input: unknown,
	now = new Date(),
	verifiedArtifacts: ReadonlyMap<
		string,
		VerifiedEvidenceArtifact | string
	> = new Map(),
): ReadinessResult {
	const parsed = parseEvidence(input, now)
	const resources = canonicalContracts.map((contract) => {
		const evidence = parsed.evidence.find(
			(item) => item.resourceId === contract.id,
		)
		const failures: Array<string> = []
		if (!evidence) {
			failures.push(`${contract.id}: missing valid dated evidence`)
		} else {
			const actualKinds = new Set(
				evidence.artifacts.map((artifact) => artifact.kind),
			)
			for (const artifact of evidence.artifacts) {
				const verified = verifiedArtifacts.get(artifact.uri)
				if (verified === undefined || typeof verified === 'string') {
					failures.push(
						`${contract.id}: signed artifact was not locally verified: ${artifact.uri}`,
					)
				} else if (verified.digest !== artifact.sha256) {
					failures.push(
						`${contract.id}: locally verified artifact digest mismatch: ${artifact.uri}`,
					)
				} else if (
					!artifactMatchesEnvelope(contract.id, artifact, verified.envelope)
				) {
					failures.push(
						`${contract.id}: signed artifact content does not match index metadata: ${artifact.uri}`,
					)
				}
			}
			for (const requiredKind of contract.requiredEvidenceKinds) {
				if (!actualKinds.has(requiredKind)) {
					failures.push(`${contract.id}: missing ${requiredKind} artifact`)
				}
			}
		}
		return { contract, evidence, failures }
	})
	const levels = {
		'd1-only': { ready: false, failures: [] as Array<string> },
		'canonical-data': { ready: false, failures: [] as Array<string> },
		'full-service': { ready: false, failures: [] as Array<string> },
	}
	for (const level of Object.keys(levels) as Array<ReadinessLevel>) {
		const failures = [
			...parsed.failures,
			...resources
				.filter(({ contract }) =>
					isRequiredAtLevel(contract.requiredFor, level),
				)
				.flatMap((resource) => resource.failures),
		]
		levels[level] = { ready: failures.length === 0, failures }
	}
	return { levels, resources, inputFailures: parsed.failures }
}

export function renderReadinessReport(result: ReadinessResult): string {
	const lines: Array<string> = []
	for (const level of ['d1-only', 'canonical-data', 'full-service'] as const) {
		const status = result.levels[level]
		lines.push(`${level}: ${status.ready ? 'READY' : 'NOT READY'}`)
		for (const failure of status.failures) lines.push(`  - ${failure}`)
	}
	lines.push('contracts:')
	for (const resource of result.resources) {
		lines.push(
			`  ${resource.contract.id}: ${resource.contract.transfer}; evidence=${resource.contract.requiredEvidenceKinds.join(',')}; includes=${resource.contract.includes.join('; ')}; excludes=${resource.contract.excludes.join('; ')}`,
		)
	}
	return lines.join('\n')
}
