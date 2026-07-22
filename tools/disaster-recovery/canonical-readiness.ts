const sha256Pattern = /^[a-f0-9]{64}$/
const isoDatePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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

export type EvidenceArtifact = {
	kind: EvidenceKind
	type: string
	uri: string
	sha256: string
}

export type ResourceEvidence = {
	resourceId: CanonicalResourceId
	verifierIdentity: string
	changeId: string
	performedAt: string
	expiresAt: string
	artifacts: Array<EvidenceArtifact>
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
		requiredEvidenceKinds: [...commonEvidenceKinds, 'd1-restore-drill'],
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

function parseEvidence(
	input: unknown,
	now: Date,
): { evidence: Array<ResourceEvidence>; failures: Array<string> } {
	if (!Array.isArray(input)) {
		return { evidence: [], failures: ['evidence input must be an array'] }
	}
	if (!Number.isFinite(now.getTime())) {
		return { evidence: [], failures: ['readiness clock is invalid'] }
	}
	const parsed: Array<ResourceEvidence> = []
	const failures: Array<string> = []
	const seenResources = new Set<string>()
	for (const [index, candidate] of input.entries()) {
		const label = `evidence[${String(index)}]`
		if (
			!candidate ||
			typeof candidate !== 'object' ||
			Array.isArray(candidate)
		) {
			failures.push(`${label}: must be an object`)
			continue
		}
		const record = candidate as Record<string, unknown>
		if (
			!exactKeys(record, [
				'artifacts',
				'changeId',
				'expiresAt',
				'performedAt',
				'resourceId',
				'verifierIdentity',
			])
		) {
			failures.push(`${label}: invalid shape`)
			continue
		}
		const resourceId = record.resourceId
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
			typeof record.verifierIdentity !== 'string' ||
			record.verifierIdentity.trim().length === 0 ||
			typeof record.changeId !== 'string' ||
			record.changeId.trim().length === 0
		) {
			failures.push(`${label}: verifier identity and change ID are required`)
			continue
		}
		if (
			typeof record.performedAt !== 'string' ||
			typeof record.expiresAt !== 'string' ||
			!isoDatePattern.test(record.performedAt) ||
			!isoDatePattern.test(record.expiresAt)
		) {
			failures.push(`${label}: performedAt and expiresAt are required`)
			continue
		}
		const performedAt = Date.parse(record.performedAt)
		const expiresAt = Date.parse(record.expiresAt)
		if (!Number.isFinite(performedAt) || !Number.isFinite(expiresAt)) {
			failures.push(`${label}: attestation dates are invalid`)
			continue
		}
		if (performedAt > now.getTime()) {
			failures.push(`${label}: performedAt is in the future`)
			continue
		}
		if (expiresAt <= now.getTime() || expiresAt <= performedAt) {
			failures.push(`${label}: attestation is expired or has invalid freshness`)
			continue
		}
		if (!Array.isArray(record.artifacts) || record.artifacts.length === 0) {
			failures.push(`${label}: artifacts must be a nonempty array`)
			continue
		}
		const artifacts: Array<EvidenceArtifact> = []
		const seenKinds = new Set<string>()
		let artifactMalformed = false
		for (const [artifactIndex, artifact] of record.artifacts.entries()) {
			const artifactLabel = `${label}.artifacts[${String(artifactIndex)}]`
			if (
				!artifact ||
				typeof artifact !== 'object' ||
				Array.isArray(artifact) ||
				!exactKeys(artifact as Record<string, unknown>, [
					'kind',
					'sha256',
					'type',
					'uri',
				])
			) {
				failures.push(`${artifactLabel}: invalid shape`)
				artifactMalformed = true
				continue
			}
			const artifactRecord = artifact as Record<string, unknown>
			if (
				typeof artifactRecord.kind !== 'string' ||
				!evidenceKinds.has(artifactRecord.kind)
			) {
				failures.push(`${artifactLabel}: unknown evidence kind`)
				artifactMalformed = true
				continue
			}
			if (seenKinds.has(artifactRecord.kind)) {
				failures.push(`${artifactLabel}: duplicate evidence kind`)
				artifactMalformed = true
				continue
			}
			seenKinds.add(artifactRecord.kind)
			if (
				typeof artifactRecord.type !== 'string' ||
				artifactRecord.type.trim().length === 0 ||
				typeof artifactRecord.uri !== 'string' ||
				artifactRecord.uri.trim().length === 0 ||
				typeof artifactRecord.sha256 !== 'string' ||
				!sha256Pattern.test(artifactRecord.sha256)
			) {
				failures.push(`${artifactLabel}: malformed artifact record`)
				artifactMalformed = true
				continue
			}
			artifacts.push(artifactRecord as EvidenceArtifact)
		}
		if (!artifactMalformed) {
			parsed.push({
				resourceId: resourceId as CanonicalResourceId,
				verifierIdentity: record.verifierIdentity,
				changeId: record.changeId,
				performedAt: record.performedAt,
				expiresAt: record.expiresAt,
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

export function assessCanonicalReadiness(
	input: unknown,
	now = new Date(),
	verifiedArtifactDigests: ReadonlyMap<string, string> = new Map(),
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
				const verifiedDigest = verifiedArtifactDigests.get(artifact.uri)
				if (verifiedDigest === undefined) {
					failures.push(
						`${contract.id}: artifact bytes were not locally verified: ${artifact.uri}`,
					)
				} else if (verifiedDigest !== artifact.sha256) {
					failures.push(
						`${contract.id}: locally verified artifact digest mismatch: ${artifact.uri}`,
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
