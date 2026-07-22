import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import { type PackageRetrieverSurfaceResult } from '#worker/package-retrievers/types.ts'

import {
	type SearchEntityDetail,
	type SearchEntityDetailStructured,
	type SearchMatch,
	type SlimSearchMatch,
} from './search-format-types.ts'
import {
	type OptionalSearchRowsResult,
	type SearchCandidate,
	type SearchPhaseTimings,
} from './search-types.ts'
import { type SearchableEntityDescriptor } from './understand-search-query.ts'

export type SearchEntityCandidateInput = {
	env: Env
	query: string
	limit: number
	offline: boolean
	userId?: string
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	optionalRows: Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userValueRows'
	>
	retrieverResults: Array<PackageRetrieverSurfaceResult>
	queryEmbedding: ReadonlyArray<number>
	sharedQueryVector?: ReadonlyArray<number>
}

export type SearchEntityDescriptorInput = {
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	optionalRows: Pick<
		OptionalSearchRowsResult,
		'packageRows' | 'userSecretRows' | 'userValueRows'
	>
}

export type SearchEntitySlimFormatInput<
	Match extends SearchMatch = SearchMatch,
> = {
	match: Match
	baseUrl: string
	username?: string | null
}

export type SearchEntityDetailFormatResult = {
	markdown: string
	structured: SearchEntityDetailStructured
}

export type SearchEntityPlugin<Type extends SearchMatch['type']> = {
	type: Type
	candidateTimingKey?: keyof Pick<
		SearchPhaseTimings,
		'capabilityCandidatesMs' | 'packageCandidatesMs'
	>
	buildDescriptors?: (
		input: SearchEntityDescriptorInput,
	) => Array<SearchableEntityDescriptor>
	buildValueRowDescriptor?: (
		row: ValueMetadata,
	) => SearchableEntityDescriptor | undefined
	buildCandidates?: (
		input: SearchEntityCandidateInput,
	) => Array<SearchCandidate> | Promise<Array<SearchCandidate>>
	formatSlimMatch?: (
		input: SearchEntitySlimFormatInput<Extract<SearchMatch, { type: Type }>>,
	) => SlimSearchMatch
	formatEntityDetail?: (
		detail: Extract<SearchEntityDetail, { type: Type }>,
	) => SearchEntityDetailFormatResult
}
