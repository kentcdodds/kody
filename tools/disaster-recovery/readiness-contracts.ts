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

export const maximumEvidenceAgeDays = {
	'd1-only': 35,
	'canonical-data': 100,
	'full-service': 200,
} as const satisfies Record<ReadinessLevel, number>
