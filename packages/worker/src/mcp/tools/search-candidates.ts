import {
	CAPABILITY_SEARCH_RRF_K,
	cosineSimilarity,
	deterministicEmbedding,
	embedTextForVectorize,
	getCapabilityVectorIndex,
	lexicalScore,
	reciprocalRankFusion,
	searchCapabilities,
	sortIdsByScore,
} from '#mcp/capabilities/capability-search.ts'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import {
	parseIntegrationConfig,
	parseIntegrationJson,
	parseIntegrationValueName,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import {
	buildValueEntityId,
	describeValue,
} from '#mcp/tools/search-entities.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import {
	buildPackageSearchDocument,
	type PackageSearchProjection,
} from '#worker/package-registry/manifest.ts'
import { savedPackageVectorId } from '#worker/package-registry/repo.ts'
import { type PackageRetrieverSurfaceResult } from '#worker/package-retrievers/types.ts'

import { maxFusedPackageCandidates } from './search-constants.ts'
import {
	buildIntegrationSearchDocument,
	flattenReferencedTypeFields,
} from './search-descriptors.ts'
import { type PackageActionMatch, type SearchMatch } from './search-format.ts'
import { buildCandidateBaseScore, scoreMatchedTerms } from './search-scoring.ts'
import {
	type PackageSearchRow,
	type SearchCandidate,
	type SearchCapabilityMatch,
} from './search-types.ts'
import { extractMeaningfulSearchTokens } from './understand-search-query.ts'

function buildPackageExportSearchFields(
	exportDetail: PackageSearchProjection['exports'][number],
) {
	return [
		exportDetail.subpath,
		exportDetail.runtimeTarget ?? '',
		exportDetail.typesPath ?? '',
		exportDetail.description ?? '',
		exportDetail.typeDefinition ?? '',
		...flattenReferencedTypeFields(exportDetail.referencedTypes),
		...(exportDetail.functions ?? []).flatMap((fn) => [
			fn.name,
			fn.description ?? '',
			fn.typeDefinition ?? '',
			...flattenReferencedTypeFields(fn.referencedTypes),
		]),
	]
}

function buildPackageActionMatches(input: {
	query: string
	meaningfulTokens: ReadonlyArray<string>
	exports: ReadonlyArray<PackageSearchProjection['exports'][number]>
}): Array<PackageActionMatch> {
	if (input.meaningfulTokens.length === 0) return []
	return input.exports
		.map((exportDetail) => {
			const searchFields = buildPackageExportSearchFields(exportDetail)
			const matchedTerms = input.meaningfulTokens.filter((token) =>
				scoreMatchedTerms(searchFields, [token]),
			)
			const termCoverage =
				matchedTerms.length / Math.max(1, input.meaningfulTokens.length)
			const score =
				lexicalScore(input.query, searchFields.join('\n')) +
				Math.min(0.5, termCoverage * 0.65)
			return {
				subpath: exportDetail.subpath,
				description: exportDetail.description,
				typeDefinition: exportDetail.typeDefinition,
				functions: (exportDetail.functions ?? []).map((fn) => ({
					name: fn.name,
					description: fn.description,
					typeDefinition: fn.typeDefinition,
				})),
				score,
				matchedTerms,
			} satisfies PackageActionMatch
		})
		.filter(
			(match) =>
				match.functions.length > 0 &&
				(match.matchedTerms.length >= 2 || match.score >= 0.35),
		)
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score
			return left.subpath.localeCompare(right.subpath)
		})
		.slice(0, 3)
}

export async function buildCapabilityCandidates(input: {
	query: string
	env: Env
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	queryVector?: ReadonlyArray<number>
}): Promise<Array<SearchCandidate>> {
	const capabilitySearch = await searchCapabilities({
		env: input.env,
		query: input.query,
		limit: Math.max(1, Object.keys(input.registry.capabilitySpecs).length),
		detail: false,
		specs: input.registry.capabilitySpecs,
		...(input.queryVector ? { queryVector: input.queryVector } : {}),
	})

	return capabilitySearch.matches
		.map((match) => {
			const spec = input.registry.capabilitySpecs[match.name]
			if (!spec || spec.name !== match.name) {
				throw new Error(
					`Capability search result "${match.name}" did not map to a registry spec by name.`,
				)
			}
			return capabilityMatchToCandidate(match, spec)
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

/**
 * Queries Vectorize for this user's `package_{id}` vectors with
 * `{ kind: 'package', userId }`. Returns null when unavailable.
 */
async function queryPackageVectorScores(input: {
	env: Env
	query: string
	rows: Array<PackageSearchRow>
	userId: string
	limit: number
	queryVector?: ReadonlyArray<number>
}): Promise<Map<string, number> | null> {
	const index = getCapabilityVectorIndex(input.env)
	if (!index || !input.userId) return null
	const recordIdByVectorId = new Map(
		input.rows.map(
			(row) => [savedPackageVectorId(row.record.id), row.record.id] as const,
		),
	)
	const queryVector = [
		...(input.queryVector ??
			(await embedTextForVectorize(input.env, input.query))),
	]
	const topK = Math.min(Math.max(input.rows.length, input.limit * 5), 100)
	const vectorMatches = await index.query(queryVector, {
		topK,
		returnMetadata: 'none',
		filter: {
			kind: { $eq: 'package' },
			userId: { $eq: input.userId },
		},
	})
	const scores = new Map<string, number>()
	for (const match of vectorMatches.matches) {
		if (typeof match.id !== 'string') continue
		const recordId = recordIdByVectorId.get(match.id)
		if (!recordId || scores.has(recordId)) continue
		scores.set(recordId, match.score)
	}
	return scores
}

export async function buildPackageCandidates(input: {
	env: Env
	query: string
	rows: Array<PackageSearchRow>
	queryEmbedding: ReadonlyArray<number>
	limit: number
	offline: boolean
	userId?: string
	queryVector?: ReadonlyArray<number>
}): Promise<Array<SearchCandidate>> {
	if (input.rows.length === 0) return []
	// Fail closed in every mode: no userId or foreign rows never enter ranking.
	if (!input.userId) return []
	if (input.rows.some((row) => row.record.userId !== input.userId)) {
		console.warn(
			JSON.stringify({
				message: 'package candidates skipped: row userId mismatch',
				expectedUserId: input.userId,
			}),
		)
		return []
	}
	const meaningfulTokens = extractMeaningfulSearchTokens(input.query)
	let vectorScoresByRecordId: Map<string, number> | null = null
	if (!input.offline && input.userId) {
		try {
			vectorScoresByRecordId = await queryPackageVectorScores({
				env: input.env,
				query: input.query,
				rows: input.rows,
				userId: input.userId,
				limit: input.limit,
				...(input.queryVector ? { queryVector: input.queryVector } : {}),
			})
		} catch (error) {
			console.warn(
				JSON.stringify({
					message: 'package vector query failed, using lexical ranking',
					error: error instanceof Error ? error.message : String(error),
				}),
			)
		}
	}
	const candidates = input.rows
		.map((entry) => {
			const exports = Array.isArray(entry.projection.exports)
				? entry.projection.exports
				: []
			const jobs = Array.isArray(entry.projection.jobs)
				? entry.projection.jobs
				: []
			const retrievers = Array.isArray(entry.projection.retrievers)
				? entry.projection.retrievers
				: []
			const services = Array.isArray(entry.projection.services)
				? entry.projection.services
				: []
			const subscriptions = Array.isArray(entry.projection.subscriptions)
				? entry.projection.subscriptions
				: []
			const readmeSnippet = entry.readmeSnippet?.snippet ?? ''
			const actionMatches = buildPackageActionMatches({
				query: input.query,
				meaningfulTokens,
				exports,
			})
			const document = [
				buildPackageSearchDocument(entry.projection),
				readmeSnippet,
			]
				.filter((value) => value.trim().length > 0)
				.join('\n')
			const lexical = Math.max(
				lexicalScore(input.query, document),
				(actionMatches[0]?.score ?? 0) * 0.8,
			)
			const vectorHit = vectorScoresByRecordId?.get(entry.record.id)
			const scoreComponents =
				vectorScoresByRecordId != null
					? buildCandidateBaseScore({
							lexical,
							...(vectorHit !== undefined ? { vector: vectorHit } : {}),
						})
					: buildCandidateBaseScore({
							lexical,
							vector: cosineSimilarity(
								input.queryEmbedding,
								deterministicEmbedding(document),
							),
						})
			return {
				match: {
					type: 'package' as const,
					packageId: entry.record.id,
					kodyId: entry.record.kodyId,
					name: entry.record.name,
					title: entry.record.name,
					description: entry.record.description,
					tags: entry.record.tags,
					hasApp: entry.record.hasApp,
					hidden: entry.record.hidden,
					readmeSnippet: entry.readmeSnippet ?? null,
					actionMatches,
				},
				type: 'package' as const,
				id: entry.record.kodyId,
				title: entry.record.name,
				searchFields: [
					entry.record.kodyId,
					entry.record.name,
					entry.record.description,
					entry.record.searchText ?? '',
					...entry.record.tags,
					...exports.flatMap(buildPackageExportSearchFields),
					...jobs.flatMap((job) => [
						job.name,
						job.entry,
						job.schedule,
						job.enabled ? 'enabled' : 'disabled',
					]),
					...services.flatMap((service) => [
						service.name,
						service.entry,
						service.mode,
						service.autoStart ? 'auto-start' : 'manual-start',
						service.timeoutMs != null ? `timeout-ms:${service.timeoutMs}` : '',
					]),
					...subscriptions.flatMap((subscription) => [
						subscription.topic,
						subscription.handler,
						subscription.description ?? '',
					]),
					...retrievers.flatMap((retriever) => [
						retriever.key,
						retriever.name,
						retriever.description,
						retriever.exportName,
						...retriever.scopes,
					]),
					...(entry.projection.appEntry ? [entry.projection.appEntry] : []),
					readmeSnippet,
					...(entry.record.hasApp ? ['app', 'ui', 'remote'] : []),
				],
				scoreComponents,
			}
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
	if (!vectorScoresByRecordId) {
		return candidates
	}
	// Fuse lexical and vector rankings to bound the online candidate set.
	const candidateIds = candidates.map((candidate) => candidate.match.packageId)
	const lexicalById = new Map(
		candidates.map(
			(candidate) =>
				[candidate.match.packageId, candidate.scoreComponents.lexical] as const,
		),
	)
	const lexicalOrder = sortIdsByScore(
		candidateIds,
		(id) => lexicalById.get(id) ?? 0,
	)
	const vectorHitIds = candidateIds.filter((id) =>
		vectorScoresByRecordId.has(id),
	)
	const vectorOrder = sortIdsByScore(
		vectorHitIds,
		(id) => vectorScoresByRecordId.get(id) ?? 0,
	)
	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const keptIds = new Set(
		sortIdsByScore(candidateIds, (id) => fused.get(id) ?? 0).slice(
			0,
			Math.min(
				maxFusedPackageCandidates,
				Math.max(input.limit * 5, input.limit),
			),
		),
	)
	return candidates.filter((candidate) =>
		keptIds.has(candidate.match.packageId),
	)
}

export function buildRetrieverResultCandidates(input: {
	query: string
	results: Array<PackageRetrieverSurfaceResult>
}): Array<SearchCandidate> {
	return input.results
		.map((result) => {
			const lexical = lexicalScore(
				input.query,
				[
					result.title,
					result.summary,
					result.details ?? '',
					result.source ?? '',
					result.kodyId,
					result.retrieverName,
				].join('\n'),
			)
			const score = Math.min(1, Math.max(0, result.score ?? 0))
			return {
				match: {
					type: 'retriever_result' as const,
					...result,
				},
				type: 'retriever_result' as const,
				id: `${result.kodyId}:${result.retrieverKey}:${result.id}`,
				title: result.title,
				searchFields: [
					result.title,
					result.summary,
					result.details ?? '',
					result.source ?? '',
					result.kodyId,
					result.retrieverName,
				],
				scoreComponents: buildCandidateBaseScore({
					lexical: Math.max(lexical, score),
				}),
			} satisfies SearchCandidate
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

export function buildValueCandidates(input: {
	query: string
	rows: Array<ValueMetadata>
}): Array<SearchCandidate> {
	return input.rows
		.flatMap((row) => {
			if (parseIntegrationValueName(row.name)) return []
			const lexical = lexicalScore(
				input.query,
				[row.name, row.description, row.scope, row.value].join('\n'),
			)
			return [
				{
					match: {
						type: 'value' as const,
						valueId: buildValueEntityId(row),
						name: row.name,
						description: describeValue(row),
						scope: row.scope,
						appId: row.appId,
					},
					type: 'value' as const,
					id: buildValueEntityId(row),
					title: row.name,
					searchFields: [row.name, row.description, row.scope, row.value],
					scoreComponents: buildCandidateBaseScore({
						lexical,
					}),
				} satisfies SearchCandidate,
			]
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

export function buildIntegrationCandidates(input: {
	query: string
	rows: Array<ValueMetadata>
	queryEmbedding: ReadonlyArray<number>
}): Array<SearchCandidate> {
	return input.rows
		.flatMap((row) => {
			const integrationName = parseIntegrationValueName(row.name)
			if (!integrationName) return []
			const config = parseIntegrationConfig(
				parseIntegrationJson(row.value),
				integrationName,
			)
			if (!config) return []
			const document = buildIntegrationSearchDocument({
				integrationName,
				description:
					row.description.trim() ||
					`Saved OAuth integration configuration (${config.flow} flow).`,
				config,
			})
			const lexical = lexicalScore(input.query, document)
			const vector = cosineSimilarity(
				input.queryEmbedding,
				deterministicEmbedding(document),
			)
			return [
				{
					match: {
						type: 'integration' as const,
						integrationName,
						title: integrationName,
						description:
							row.description.trim() ||
							`Saved OAuth integration configuration (${config.flow} flow).`,
						flow: config.flow,
						tokenUrl: config.tokenUrl,
						apiBaseUrl: config.apiBaseUrl ?? null,
						requiredHosts: config.requiredHosts ?? [],
						clientIdValueName: config.clientIdValueName,
						clientSecretSecretName: config.clientSecretSecretName ?? null,
						accessTokenSecretName: config.accessTokenSecretName,
						refreshTokenSecretName: config.refreshTokenSecretName ?? null,
						authorization: config.authorization ?? null,
					},
					type: 'integration' as const,
					id: integrationName,
					title: integrationName,
					searchFields: [
						integrationName,
						row.description,
						config.flow,
						config.apiBaseUrl ?? '',
						config.tokenUrl,
						config.authorization?.authorizeUrl ?? '',
						...(config.authorization?.scopes ?? []),
						...(config.requiredHosts ?? []),
					],
					scoreComponents: buildCandidateBaseScore({
						lexical,
						vector,
					}),
				} satisfies SearchCandidate,
			]
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

export function buildSecretCandidates(input: {
	query: string
	rows: Array<SecretSearchRow>
}): Array<SearchCandidate> {
	return input.rows
		.map((row) => {
			const lexical = lexicalScore(
				input.query,
				`${row.name}\n${row.description}`,
			)
			return {
				match: {
					type: 'secret' as const,
					name: row.name,
					description: row.description,
				},
				type: 'secret' as const,
				id: row.name,
				title: row.name,
				searchFields: [row.name, row.description],
				scoreComponents: buildCandidateBaseScore({
					lexical,
				}),
			}
		})
		.filter((candidate) => candidate.scoreComponents.base > 0)
}

function getSynthesizedProviderIdentity(spec: CapabilitySpec):
	| {
			key: string
			providerFields: Array<string>
			operationFields: Array<string>
	  }
	| undefined {
	switch (spec.source) {
		case 'builtin':
			return undefined
		case 'remote-connector':
			return spec.remoteConnector
				? {
						key: `remote-connector:${spec.remoteConnector.instanceId}`,
						providerFields: [
							spec.remoteConnector.instanceId,
							spec.remoteConnector.connectorId,
							spec.remoteConnector.connectorName,
						],
						operationFields: [
							spec.remoteConnector.mcpToolName,
							spec.remoteConnector.toolName,
						],
					}
				: undefined
		case 'mcp-server':
			return spec.mcpServer
				? {
						key: `mcp-server:${spec.mcpServer.serverId}`,
						providerFields: [
							spec.mcpServer.serverName,
							spec.mcpServer.kodyName,
						],
						operationFields: [
							spec.mcpServer.mcpToolName,
							spec.mcpServer.toolName,
						],
					}
				: undefined
		case 'openapi':
			return spec.openApi
				? {
						key: `openapi:${spec.openApi.bindingName}`,
						providerFields: [spec.openApi.bindingName, spec.openApi.kodyName],
						operationFields: [spec.openApi.operationSlug],
					}
				: undefined
		default: {
			const exhaustiveSource: never = spec.source
			return exhaustiveSource
		}
	}
}

function capabilityMatchToCandidate(
	match: SearchCapabilityMatch,
	spec: CapabilitySpec,
): SearchCandidate {
	const providerIdentity = getSynthesizedProviderIdentity(spec)
	return {
		match: {
			type: 'capability',
			name: spec.name,
			description: spec.description,
			source: spec.source,
			...(spec.remoteConnector
				? { remoteConnector: spec.remoteConnector }
				: {}),
			...(spec.mcpServer ? { mcpServer: spec.mcpServer } : {}),
			...(spec.openApi ? { openApi: spec.openApi } : {}),
		},
		type: 'capability',
		id: spec.name,
		title: spec.name,
		searchFields: [
			spec.name,
			spec.domain,
			spec.description,
			...(spec.keywords ?? []),
			...(spec.inputFields ?? []),
			...(spec.outputFields ?? []),
		],
		identityFields: [
			spec.name,
			spec.domain,
			...(providerIdentity?.operationFields ?? []),
		],
		...(providerIdentity
			? {
					providerIdentityFields: providerIdentity.providerFields,
					synthesizedProviderKey: providerIdentity.key,
				}
			: {}),
		scoreComponents: buildCandidateBaseScore({
			lexical: match.lexicalScore,
			...(match.vectorRank != null ? { vector: match.vectorScore } : {}),
		}),
	}
}

export async function hydrateTopPackageMatches(input: {
	query: string
	matches: Array<SearchMatch>
	rows: Array<PackageSearchRow>
}): Promise<void> {
	const rowsByRecordId = new Map(
		input.rows.map((row) => [row.record.id, row] as const),
	)
	const packageMatches = input.matches.flatMap((match) =>
		match.type === 'package' ? [match] : [],
	)
	if (packageMatches.length === 0) return
	const meaningfulTokens = extractMeaningfulSearchTokens(input.query)
	await Promise.all(
		packageMatches.map(async (match) => {
			const row = rowsByRecordId.get(match.packageId)
			if (!row?.hydrate) return
			try {
				const hydrated = await row.hydrate()
				match.readmeSnippet = hydrated.readmeSnippet
				match.actionMatches = buildPackageActionMatches({
					query: input.query,
					meaningfulTokens,
					exports: hydrated.projection.exports,
				})
			} catch (error) {
				console.warn(
					JSON.stringify({
						message: 'package search match hydration failed',
						packageId: match.packageId,
						error: error instanceof Error ? error.message : String(error),
					}),
				)
			}
		}),
	)
}
