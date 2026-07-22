import {
	deterministicEmbedding,
	embedTextForVectorize,
	isCapabilitySearchOffline,
} from '#mcp/capabilities/capability-search.ts'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { type PackageRetrieverSurfaceResult } from '#worker/package-retrievers/types.ts'

import {
	buildRecommendedNextStep,
	buildSearchableEntityDescriptors,
} from './search-descriptors.ts'
import { searchEntityPlugins } from './search-entity-registry.ts'
import { hydrateTopPackageMatches } from './search-entity-plugins/package.ts'
import { type SearchMatch } from './search-format.ts'
import { attachTopCapabilityCallShapes } from './search-related-capabilities.ts'
import {
	buildCandidateBaseScore,
	buildCandidateTelemetry,
	rerankCandidates,
} from './search-scoring.ts'
import { elapsedMs } from './search-timing.ts'
import {
	type OptionalSearchRowsResult,
	type PackageSearchRow,
	type SearchCandidate,
	type SearchPhaseTimings,
	type SearchUnifiedResult,
} from './search-types.ts'
import { understandSearchQuery } from './understand-search-query.ts'

export function buildExactPackageSearchResult(input: {
	env: Env
	query: string
	match: Extract<SearchMatch, { type: 'package' }> | null
}): SearchUnifiedResult {
	const queryUnderstandingStart = performance.now()
	const intent = understandSearchQuery({
		query: input.query,
		entities: [],
	})
	const queryUnderstandingMs = elapsedMs(queryUnderstandingStart)
	const matches = input.match ? [input.match] : []
	const candidates: Array<SearchCandidate> = input.match
		? [
				{
					match: input.match,
					type: 'package',
					id: input.match.kodyId,
					title: input.match.title,
					searchFields: [input.match.kodyId, input.match.name],
					scoreComponents: buildCandidateBaseScore({
						lexical: 1,
						vector: 1,
					}),
				},
			]
		: []
	const guidance = buildRecommendedNextStep({
		query: input.query,
		intent,
		matches,
	})
	return {
		matches,
		offline: isCapabilitySearchOffline(input.env),
		intent,
		telemetry: buildCandidateTelemetry({
			intent,
			candidates,
			matches,
		}),
		phaseTimings: {
			queryUnderstandingMs,
			candidateGenerationMs: 0,
			rerankingMs: 0,
		},
		...(guidance ? { guidance } : {}),
	}
}

export async function searchUnified(input: {
	env: Env
	query: string
	limit: number
	/** Authenticated user; required for fail-closed package Vectorize isolation. */
	userId?: string
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	optionalRows: Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userValueRows'
	>
	retrieverResults?: Array<PackageRetrieverSurfaceResult>
}): Promise<SearchUnifiedResult> {
	const offline = isCapabilitySearchOffline(input.env)
	const query = input.query.trim()
	if (!query) {
		const queryUnderstandingStart = performance.now()
		const emptyIntent = understandSearchQuery({
			query,
			entities: [],
		})
		const queryUnderstandingMs = elapsedMs(queryUnderstandingStart)
		return {
			matches: [],
			offline,
			intent: emptyIntent,
			telemetry: buildCandidateTelemetry({
				intent: emptyIntent,
				candidates: [],
				matches: [],
			}),
			phaseTimings: {
				queryUnderstandingMs,
				candidateGenerationMs: 0,
				rerankingMs: 0,
			},
		}
	}

	const limit = Math.max(1, input.limit)
	const entityDescriptors = buildSearchableEntityDescriptors({
		registry: input.registry,
		optionalRows: input.optionalRows,
	})
	const queryUnderstandingStart = performance.now()
	const intent = understandSearchQuery({
		query,
		entities: entityDescriptors,
	})
	const queryUnderstandingMs = elapsedMs(queryUnderstandingStart)
	const candidateGenerationStart = performance.now()
	const queryEmbeddingStart = performance.now()
	const queryEmbedding = deterministicEmbedding(intent.normalizedQuery)
	const sharedQueryVector = offline
		? queryEmbedding
		: await embedTextForVectorize(input.env, intent.normalizedQuery)
	const queryEmbeddingMs = elapsedMs(queryEmbeddingStart)

	const candidateResults = await Promise.all(
		searchEntityPlugins.map(async (plugin) => {
			const startedAt = performance.now()
			const candidates = plugin.buildCandidates
				? await plugin.buildCandidates({
						env: input.env,
						query: intent.normalizedQuery,
						limit,
						offline,
						...(input.userId ? { userId: input.userId } : {}),
						registry: input.registry,
						optionalRows: input.optionalRows,
						retrieverResults: input.retrieverResults ?? [],
						queryEmbedding,
						sharedQueryVector,
					})
				: []
			return {
				plugin,
				candidates,
				durationMs: elapsedMs(startedAt),
			}
		}),
	)
	const candidates = candidateResults.flatMap((result) => result.candidates)
	const candidateTimings: Pick<
		SearchPhaseTimings,
		'capabilityCandidatesMs' | 'packageCandidatesMs'
	> = {}
	for (const result of candidateResults) {
		const candidateTimingKey =
			'candidateTimingKey' in result.plugin
				? result.plugin.candidateTimingKey
				: undefined
		if (candidateTimingKey === 'capabilityCandidatesMs') {
			candidateTimings.capabilityCandidatesMs = result.durationMs
		}
		if (candidateTimingKey === 'packageCandidatesMs') {
			candidateTimings.packageCandidatesMs = result.durationMs
		}
	}
	const candidateGenerationMs = elapsedMs(candidateGenerationStart)
	const rerankingStart = performance.now()
	const reranked = rerankCandidates({
		candidates,
		intent,
		limit,
	})
	const matches = reranked.map((candidate) => candidate.match)
	attachTopCapabilityCallShapes({
		matches,
		registry: input.registry,
	})
	await hydrateTopPackageMatches({
		query: intent.normalizedQuery,
		matches,
		rows: input.optionalRows.packageRows,
	})
	const rerankingMs = elapsedMs(rerankingStart)

	return {
		matches,
		offline,
		intent,
		telemetry: buildCandidateTelemetry({
			intent,
			candidates,
			matches,
		}),
		phaseTimings: {
			queryUnderstandingMs,
			candidateGenerationMs,
			rerankingMs,
			queryEmbeddingMs,
			...candidateTimings,
		},
		guidance: buildRecommendedNextStep({
			query,
			intent,
			matches,
		}),
	}
}

export async function searchPackages(input: {
	env: Env
	baseUrl: string
	query: string
	limit: number
	userId?: string
	rows: Array<PackageSearchRow>
}): Promise<{ matches: Array<SearchMatch>; offline: boolean }> {
	const result = await searchUnified({
		env: input.env,
		query: input.query,
		limit: input.limit,
		userId: input.userId,
		registry: {
			capabilitySpecs: {},
		} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>,
		optionalRows: {
			packageRows: input.rows,
			userSecretRows: [],
			userValueRows: [],
		},
	})
	return {
		matches: result.matches,
		offline: result.offline,
	}
}
