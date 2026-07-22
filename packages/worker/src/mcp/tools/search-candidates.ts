import { deterministicEmbedding } from '#mcp/capabilities/capability-search.ts'
import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { type SecretSearchRow } from '#mcp/secrets/types.ts'
import { type ValueMetadata } from '#mcp/values/types.ts'
import { type PackageRetrieverSurfaceResult } from '#worker/package-retrievers/types.ts'

import { capabilitySearchEntityPlugin } from './search-entity-plugins/capability.ts'
import { integrationSearchEntityPlugin } from './search-entity-plugins/integration.ts'
import {
	hydrateTopPackageMatches,
	packageSearchEntityPlugin,
} from './search-entity-plugins/package.ts'
import { retrieverResultSearchEntityPlugin } from './search-entity-plugins/retriever-result.ts'
import { secretSearchEntityPlugin } from './search-entity-plugins/secret.ts'
import { valueSearchEntityPlugin } from './search-entity-plugins/value.ts'
import { type SearchMatch } from './search-format.ts'
import { type PackageSearchRow, type SearchCandidate } from './search-types.ts'

const emptyRegistry = {
	capabilitySpecs: {},
} as Awaited<ReturnType<typeof getCapabilityRegistryForContext>>

export async function buildCapabilityCandidates(input: {
	query: string
	env: Env
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	queryVector?: ReadonlyArray<number>
}): Promise<Array<SearchCandidate>> {
	return await capabilitySearchEntityPlugin.buildCandidates({
		env: input.env,
		query: input.query,
		limit: Math.max(1, Object.keys(input.registry.capabilitySpecs).length),
		offline: false,
		registry: input.registry,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
		},
		retrieverResults: [],
		queryEmbedding: input.queryVector ?? deterministicEmbedding(input.query),
		...(input.queryVector ? { sharedQueryVector: input.queryVector } : {}),
	})
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
	return await packageSearchEntityPlugin.buildCandidates({
		env: input.env,
		query: input.query,
		limit: input.limit,
		offline: input.offline,
		...(input.userId ? { userId: input.userId } : {}),
		registry: emptyRegistry,
		optionalRows: {
			packageRows: input.rows,
			userSecretRows: [],
			userValueRows: [],
		},
		retrieverResults: [],
		queryEmbedding: input.queryEmbedding,
		...(input.queryVector ? { sharedQueryVector: input.queryVector } : {}),
	})
}

export function buildRetrieverResultCandidates(input: {
	query: string
	results: Array<PackageRetrieverSurfaceResult>
}): Array<SearchCandidate> {
	return retrieverResultSearchEntityPlugin.buildCandidates({
		env: {} as Env,
		query: input.query,
		limit: input.results.length,
		offline: true,
		registry: emptyRegistry,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: [],
		},
		retrieverResults: input.results,
		queryEmbedding: deterministicEmbedding(input.query),
	})
}

export function buildValueCandidates(input: {
	query: string
	rows: Array<ValueMetadata>
}): Array<SearchCandidate> {
	return valueSearchEntityPlugin.buildCandidates({
		env: {} as Env,
		query: input.query,
		limit: input.rows.length,
		offline: true,
		registry: emptyRegistry,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: input.rows,
		},
		retrieverResults: [],
		queryEmbedding: deterministicEmbedding(input.query),
	})
}

export function buildIntegrationCandidates(input: {
	query: string
	rows: Array<ValueMetadata>
	queryEmbedding: ReadonlyArray<number>
}): Array<SearchCandidate> {
	return integrationSearchEntityPlugin.buildCandidates({
		env: {} as Env,
		query: input.query,
		limit: input.rows.length,
		offline: true,
		registry: emptyRegistry,
		optionalRows: {
			packageRows: [],
			userSecretRows: [],
			userValueRows: input.rows,
		},
		retrieverResults: [],
		queryEmbedding: input.queryEmbedding,
	})
}

export function buildSecretCandidates(input: {
	query: string
	rows: Array<SecretSearchRow>
}): Array<SearchCandidate> {
	return secretSearchEntityPlugin.buildCandidates({
		env: {} as Env,
		query: input.query,
		limit: input.rows.length,
		offline: true,
		registry: emptyRegistry,
		optionalRows: {
			packageRows: [],
			userSecretRows: input.rows,
			userValueRows: [],
		},
		retrieverResults: [],
		queryEmbedding: deterministicEmbedding(input.query),
	})
}

export { hydrateTopPackageMatches }
export type { SearchMatch }
