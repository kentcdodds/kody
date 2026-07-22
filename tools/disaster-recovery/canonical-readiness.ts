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

export type ResourceContract = {
	id: CanonicalResourceId
	requiredFor: ReadinessLevel
	transfer:
		| 'd1-logical-import'
		| 'derived-data-rebuild'
		| 'git-mirror'
		| 'operational-rebuild'
		| 'oauth-reauthorization'
		| 'r2-object-copy'
		| 'secret-fingerprint-escrow'
		| 'storage-runner-export'
	includes: ReadonlyArray<string>
	excludes: ReadonlyArray<string>
}

export const canonicalContracts = [
	{
		id: 'APP_DB',
		requiredFor: 'd1-only',
		transfer: 'd1-logical-import',
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
		includes: ['all user-uploaded avatar objects with keys and metadata'],
		excludes: ['derived package icons', 'regenerable derived assets'],
	},
	{
		id: 'STORAGE_RUNNER',
		requiredFor: 'canonical-data',
		transfer: 'storage-runner-export',
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
		includes: ['mirror clone containing every ref and complete Git history'],
		excludes: ['default-branch-only clone', 'working tree as history coverage'],
	},
	{
		id: 'SECRET_STORE_KEY',
		requiredFor: 'canonical-data',
		transfer: 'secret-fingerprint-escrow',
		includes: [
			'external source key fingerprint evidence',
			'external destination key fingerprint evidence',
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
		includes: [
			'icon derivation inventory and deterministic rebuild procedure',
			'post-rebuild object verification',
		],
		excludes: [
			'treating derived icons as user-uploaded COMMUNITY_ASSETS avatars',
		],
	},
	{
		id: 'ALARMS',
		requiredFor: 'full-service',
		transfer: 'operational-rebuild',
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
		includes: [
			'queue, consumer, dead-letter, and workflow configuration inventory',
			'destination provisioning credentials and replay/runbook evidence',
			'post-rebuild delivery and workflow execution verification',
		],
		excludes: [
			'claiming in-flight queue messages are covered without explicit evidence',
			'claiming active workflow instances are recreated from configuration',
		],
	},
	{
		id: 'OAUTH',
		requiredFor: 'full-service',
		transfer: 'oauth-reauthorization',
		includes: [
			'per-user connector inventory',
			'post-restore user reauthorization',
		],
		excludes: ['copying access tokens', 'copying refresh tokens'],
	},
] as const satisfies ReadonlyArray<ResourceContract>

export type ResourceEvidence = {
	id: CanonicalResourceId
	supported: boolean
	inventoryComplete: boolean
	sourceCredential: boolean
	destinationCredential: boolean
	contractRepresented: boolean
	evidence: Array<string>
}

export type ReadinessResult = {
	levels: Record<ReadinessLevel, { ready: boolean; failures: Array<string> }>
	resources: Array<{
		contract: ResourceContract
		evidence?: ResourceEvidence
		failures: Array<string>
	}>
}

const levelOrder: Record<ReadinessLevel, number> = {
	'd1-only': 0,
	'canonical-data': 1,
	'full-service': 2,
}

function isRequiredAtLevel(
	requiredFor: ReadinessLevel,
	level: ReadinessLevel,
): boolean {
	return levelOrder[requiredFor] <= levelOrder[level]
}

export function assessCanonicalReadiness(
	evidence: ReadonlyArray<ResourceEvidence>,
): ReadinessResult {
	const resources = canonicalContracts.map((contract) => {
		const matching = evidence.filter((item) => item.id === contract.id)
		const item = matching[0]
		const failures: Array<string> = []
		if (matching.length === 0) {
			failures.push(`${contract.id}: missing inventory evidence`)
		} else if (matching.length > 1) {
			failures.push(`${contract.id}: duplicate inventory evidence`)
		}
		if (item) {
			if (!item.supported) failures.push(`${contract.id}: transfer unsupported`)
			if (!item.inventoryComplete) {
				failures.push(`${contract.id}: inventory is incomplete`)
			}
			if (!item.sourceCredential) {
				failures.push(`${contract.id}: source credential is missing`)
			}
			if (!item.destinationCredential) {
				failures.push(`${contract.id}: destination credential is missing`)
			}
			if (!item.contractRepresented) {
				failures.push(`${contract.id}: canonical contract is not represented`)
			}
			if (item.evidence.length === 0) {
				failures.push(`${contract.id}: no verification evidence supplied`)
			}
		}
		return { contract, evidence: item, failures }
	})

	const levels = {
		'd1-only': { ready: false, failures: [] as Array<string> },
		'canonical-data': { ready: false, failures: [] as Array<string> },
		'full-service': { ready: false, failures: [] as Array<string> },
	}
	for (const level of Object.keys(levels) as Array<ReadinessLevel>) {
		const failures = resources
			.filter(({ contract }) => isRequiredAtLevel(contract.requiredFor, level))
			.flatMap((resource) => resource.failures)
		levels[level] = { ready: failures.length === 0, failures }
	}
	return { levels, resources }
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
			`  ${resource.contract.id}: ${resource.contract.transfer}; includes=${resource.contract.includes.join('; ')}; excludes=${resource.contract.excludes.join('; ')}`,
		)
	}
	return lines.join('\n')
}
