import { isRecord } from '@kody-internal/shared/is-record.ts'

import {
	type CanonicalResourceId,
	type EvidenceArtifact,
	type EvidenceDetailsByKind,
	type ReadinessLevel,
	type ReadinessResult,
	type ResourceIdentity,
	type SignedEvidenceEnvelope,
	type VerifiedEvidenceArtifact,
	canonicalContracts,
	maximumEvidenceAgeDays,
} from './readiness-contracts.ts'
import {
	exactKeys,
	identitiesEqual,
	isIsoDate,
	isNonemptyString,
	parseIdentity,
	sha256Pattern,
} from './readiness-validation.ts'
import { canonicalJson, sha256 } from './canonical-json.ts'

const millisecondsPerDay = 24 * 60 * 60 * 1000
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
					'expiresAt',
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
				!isIsoDate(artifact.performedAt) ||
				!isIsoDate(artifact.expiresAt) ||
				Date.parse(artifact.expiresAt) <= Date.parse(artifact.performedAt)
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
				artifact.performedAt !== candidate.performedAt ||
				artifact.expiresAt !== candidate.expiresAt
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
		content.performedAt === artifact.performedAt &&
		content.expiresAt === artifact.expiresAt
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
	trustedProductionSources: ReadonlyArray<{
		accountId: string
		databaseId: string
		databaseName: string
	}> = [],
	trustedBaselines: ReadonlyArray<{
		id: string
		canonicalSha256: string
		source: {
			accountId: string
			databaseId: string
			databaseName: string
		}
		baseline: {
			schemaSha256: string
			migrationNames: ReadonlyArray<string>
			isolationChecks: ReadonlyArray<unknown>
		}
	}> = [],
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
			if (contract.id === 'APP_DB') {
				const restoreArtifact = evidence.artifacts.find(
					(artifact) => artifact.kind === 'd1-restore-drill',
				)
				const sizeArtifact = evidence.artifacts.find(
					(artifact) => artifact.kind === 'd1-size-ceiling-check',
				)
				const restoreVerified = restoreArtifact
					? verifiedArtifacts.get(restoreArtifact.uri)
					: undefined
				const sizeVerified = sizeArtifact
					? verifiedArtifacts.get(sizeArtifact.uri)
					: undefined
				if (
					restoreVerified &&
					typeof restoreVerified !== 'string' &&
					sizeVerified &&
					typeof sizeVerified !== 'string'
				) {
					const source = restoreVerified.envelope.content.sourceIdentity
					const restoreDetails = restoreVerified.envelope.content
						.details as EvidenceDetailsByKind['d1-restore-drill']
					const sizeDetails = sizeVerified.envelope.content
						.details as EvidenceDetailsByKind['d1-size-ceiling-check']
					const trustedSource = trustedProductionSources.find(
						(candidate) =>
							candidate.accountId.toLowerCase() ===
								source.accountId.toLowerCase() &&
							candidate.databaseId.toLowerCase() ===
								source.resourceId.toLowerCase() &&
							candidate.databaseName === restoreDetails.sourceDatabaseName,
					)
					if (!trustedSource) {
						failures.push(
							'APP_DB: signed source identity/name is not a checked production source',
						)
					}
					const provenanceKeys = [
						'backupManifestSha256',
						'isolationBaselineSha256',
						'migrationSetSha256',
						'schemaSha256',
						'sourceBookmark',
						'sourceDatabaseName',
						'sqlSha256',
						'trustedBaselineId',
						'trustedBaselineSha256',
					] as const
					for (const key of provenanceKeys) {
						if (restoreDetails[key] !== sizeDetails[key]) {
							failures.push(
								`APP_DB: signed restore ${key} does not match source evidence`,
							)
						}
					}
					const baseline = trustedBaselines.find(
						(candidate) =>
							candidate.id === restoreDetails.trustedBaselineId &&
							candidate.canonicalSha256 ===
								restoreDetails.trustedBaselineSha256,
					)
					if (
						!baseline ||
						baseline.source.accountId.toLowerCase() !==
							source.accountId.toLowerCase() ||
						baseline.source.databaseId.toLowerCase() !==
							source.resourceId.toLowerCase() ||
						baseline.source.databaseName !==
							restoreDetails.sourceDatabaseName ||
						baseline.baseline.schemaSha256 !== restoreDetails.schemaSha256 ||
						sha256(
							canonicalJson([...baseline.baseline.migrationNames].sort()),
						) !== restoreDetails.migrationSetSha256 ||
						sha256(canonicalJson(baseline.baseline.isolationChecks)) !==
							restoreDetails.isolationBaselineSha256
					) {
						failures.push(
							'APP_DB: signed restore baseline provenance is not checked or does not match',
						)
					}
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
