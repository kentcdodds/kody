import { type searchCapabilities } from '#mcp/capabilities/capability-search.ts'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type MemoryToolSummary } from '#mcp/tools/memory-tool-context.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'
import { type PackageSearchProjection } from '#worker/package-registry/manifest.ts'
import { type PackageReadmeSnippet } from '#worker/package-registry/package-readme.ts'
import { type listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'

import { type SearchMatch } from './search-format-types.ts'
import { type SearchIntent } from './understand-search-query.ts'

export type PackageSearchRow = {
	record: Awaited<ReturnType<typeof listSavedPackagesByUserId>>[number]
	projection: PackageSearchProjection
	readmeSnippet?: PackageReadmeSnippet | null
	hydrate?: () => Promise<{
		projection: PackageSearchProjection
		readmeSnippet: PackageReadmeSnippet | null
	}>
}

export type OptionalSearchRowsResult = {
	packageRows: Array<PackageSearchRow>
	userSecretRows: Array<SecretSearchRow>
	userValueRows: Array<ValueMetadata>
	userIntegrationRows: Array<JoinedIntegration>
	warnings: Array<string>
}

export type LoadedPackageRows =
	| Array<PackageSearchRow>
	| BuildSavedPackageSearchRowsResult

export type SearchScoreComponents = {
	base: number
	lexical: number
	vector: number
	entityMatch: number
	providerEntityAffinity: number
	actionMatch: number
	taskAffinity: number
	appAvailability: number
	wrapperWorkflow: number
	constraint: number
	final: number
}

export type SearchCandidate = {
	match: SearchMatch
	type: SearchMatch['type']
	id: string
	title: string
	searchFields: Array<string>
	identityFields?: Array<string>
	providerIdentityFields?: Array<string>
	synthesizedProviderKey?: string
	scoreComponents: SearchScoreComponents
}

export type SearchTelemetry = {
	intent: {
		task: SearchIntent['task']['name']
		confidence: number
		entityCount: number
		actionCount: number
		constraintCount: number
		topEntities: Array<{
			type: string
			id: string
			confidence: number
		}>
	}
	candidateCounts: Partial<Record<SearchMatch['type'], number>>
	topResultTypes: Array<SearchMatch['type']>
	trimmedMatchCount?: number
	responseTrimmed?: boolean
}

export type SearchPhaseTimings = {
	queryUnderstandingMs: number
	candidateGenerationMs: number
	rerankingMs: number
	formattingMs?: number
	rowAndRegistryLoadMs?: number
	retrieversMs?: number
	queryEmbeddingMs?: number
	capabilityCandidatesMs?: number
	packageCandidatesMs?: number
	remoteConnectorStatusMs?: number
	memoryEnrichmentMs?: number
	memoryEnrichmentWaitMs?: number
	memoryAcknowledgementMs?: number
	memoryEnrichmentTimedOut?: boolean
	memoryAcknowledgementTimedOut?: boolean
	memoryEnrichmentFailed?: boolean
	memoryAcknowledgementFailed?: boolean
}

export type SearchGuidanceContext = {
	query: string
	intent: SearchIntent
	matches: Array<SearchMatch>
}

export type SearchCapabilityMatch = Awaited<
	ReturnType<typeof searchCapabilities>
>['matches'][number]

export type SearchUnifiedResult = {
	matches: Array<SearchMatch>
	offline: boolean
	intent: SearchIntent
	telemetry: SearchTelemetry
	phaseTimings: SearchPhaseTimings
	guidance?: string
}

export type BuildSavedPackageSearchRowsResult = {
	rows: Array<PackageSearchRow>
	warnings: Array<string>
}

export type SearchMemoryEnrichmentSettlement = {
	memories?: {
		surfaced: MemoryToolSummary['memories']
		suppressedCount: number
		retrievalQuery: string
		retrieverResults: MemoryToolSummary['retrieverResults']
	}
	warnings: Array<string>
	phaseTimings: Pick<
		SearchPhaseTimings,
		| 'memoryEnrichmentMs'
		| 'memoryEnrichmentWaitMs'
		| 'memoryAcknowledgementMs'
		| 'memoryEnrichmentTimedOut'
		| 'memoryAcknowledgementTimedOut'
		| 'memoryEnrichmentFailed'
		| 'memoryAcknowledgementFailed'
	>
}

export type SearchRowsAndRegistry = OptionalSearchRowsResult & {
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}
