import { type getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { type CapabilitySpec } from '#mcp/capabilities/types.ts'

import { type SearchMatch } from './search-format-types.ts'
import { type SearchCandidate } from './search-types.ts'
import {
	extractSearchTokens,
	normalizeSearchText,
} from './understand-search-query.ts'

const providerOnlyQueryTokens = new Set([
	'api',
	'binding',
	'integration',
	'mcp',
	'openapi',
	'operation',
	'operations',
	'provider',
	'server',
	'tool',
	'tools',
])
const maxTaskSpecificProviderOperations = 2
const providerSampleCount = 3

type SynthesizedProvider = {
	key: string
	title: string
	domain: string
	source: 'mcp-server' | 'openapi'
	identityFields: Array<string>
	operationIdentityFields: Array<string>
	specs: Array<CapabilitySpec>
	usage: string
}

function getProviderIdentity(spec: CapabilitySpec): SynthesizedProvider | null {
	if (spec.openApi) {
		return {
			key: `openapi:${spec.openApi.bindingName}`,
			title: spec.openApi.bindingName,
			domain: spec.domain,
			source: 'openapi',
			identityFields: [spec.openApi.bindingName, spec.openApi.kodyName],
			operationIdentityFields: [spec.name, spec.openApi.operationSlug],
			specs: [spec],
			usage: `kody.openapi[${JSON.stringify(spec.openApi.kodyName)}].operation_slug(args)`,
		}
	}
	if (spec.mcpServer) {
		return {
			key: `mcp-server:${spec.mcpServer.serverId}`,
			title: spec.mcpServer.serverName,
			domain: spec.domain,
			source: 'mcp-server',
			identityFields: [spec.mcpServer.serverName, spec.mcpServer.kodyName],
			operationIdentityFields: [
				spec.name,
				spec.mcpServer.mcpToolName,
				spec.mcpServer.toolName,
			],
			specs: [spec],
			usage: `kody.mcp[${JSON.stringify(spec.mcpServer.kodyName)}].tool_name(args)`,
		}
	}
	return null
}

function buildProviders(
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>,
) {
	const providers = new Map<string, SynthesizedProvider>()
	for (const spec of Object.values(registry.capabilitySpecs)) {
		const identity = getProviderIdentity(spec)
		if (!identity) continue
		const existing = providers.get(identity.key)
		if (!existing) {
			providers.set(identity.key, identity)
			continue
		}
		existing.specs.push(spec)
		existing.operationIdentityFields.push(...identity.operationIdentityFields)
	}
	return providers
}

export function queryMatchesSynthesizedProvider(input: {
	query: string
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}) {
	return [...buildProviders(input.registry).values()].some((provider) =>
		queryTargetsProvider(input.query, provider),
	)
}

function packageWrapsProvider(
	candidate: SearchCandidate,
	provider: SynthesizedProvider,
) {
	if (candidate.type !== 'package' || !candidate.packageIdentityFields) {
		return false
	}
	const packageTokens = new Set(
		candidate.packageIdentityFields.flatMap(extractSearchTokens),
	)
	return provider.identityFields
		.flatMap(extractSearchTokens)
		.some((token) => packageTokens.has(token))
}

function queryTargetsProvider(query: string, provider: SynthesizedProvider) {
	const queryTokens = new Set(extractSearchTokens(query))
	return provider.identityFields
		.flatMap(extractSearchTokens)
		.some((token) => queryTokens.has(token))
}

function isExactOperationQuery(query: string, provider: SynthesizedProvider) {
	const normalizedQuery = normalizeSearchText(query).trim()
	return provider.operationIdentityFields.some(
		(identity) => normalizeSearchText(identity).trim() === normalizedQuery,
	)
}

function shouldKeepTaskOperations(
	query: string,
	provider: SynthesizedProvider,
) {
	const providerTokens = new Set(
		provider.identityFields.flatMap(extractSearchTokens),
	)
	return extractSearchTokens(query).some(
		(token) =>
			!providerTokens.has(token) && !providerOnlyQueryTokens.has(token),
	)
}

function buildProviderCard(input: {
	provider: SynthesizedProvider
	candidates: ReadonlyArray<SearchCandidate>
}): Extract<SearchMatch, { type: 'provider' }> {
	const wrappingCandidate = input.candidates.find((candidate) =>
		packageWrapsProvider(candidate, input.provider),
	)
	const wrappingPackage =
		wrappingCandidate?.match.type === 'package'
			? {
					kodyId: wrappingCandidate.match.kodyId,
					name: wrappingCandidate.match.name,
					entityRef: `${wrappingCandidate.match.kodyId}:package`,
				}
			: null
	const capabilityCount = input.provider.specs.length
	return {
		type: 'provider',
		id: input.provider.key,
		title: input.provider.title,
		description: `${input.provider.source === 'openapi' ? 'OpenAPI' : 'MCP'} provider with ${String(capabilityCount)} ${capabilityCount === 1 ? 'operation' : 'operations'}.`,
		domain: input.provider.domain,
		source: input.provider.source,
		capabilityCount,
		sampleCapabilities: input.provider.specs
			.slice(0, providerSampleCount)
			.map((spec) => spec.name),
		usage: input.provider.usage,
		wrappingPackage,
	}
}

/**
 * Replaces provider-name floods with one provider card. A task-specific query
 * may retain two top operations; exact operation names remain untouched.
 */
export function collapseSynthesizedProviderMatches(input: {
	query: string
	candidates: Array<SearchCandidate>
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}): Array<SearchMatch> {
	const providers = buildProviders(input.registry)
	const representedProviderKeys = new Set(
		input.candidates.flatMap((candidate) =>
			candidate.type === 'capability' && candidate.synthesizedProviderKey
				? [candidate.synthesizedProviderKey]
				: [],
		),
	)
	const collapsedProviders = new Map(
		[...providers].filter(
			([key, provider]) =>
				representedProviderKeys.has(key) &&
				queryTargetsProvider(input.query, provider) &&
				!isExactOperationQuery(input.query, provider),
		),
	)
	if (collapsedProviders.size === 0) {
		return input.candidates.map((candidate) => candidate.match)
	}

	const emittedCards = new Set<string>()
	const retainedOperationsByProvider = new Map<string, number>()
	const matches: Array<SearchMatch> = []
	for (const candidate of input.candidates) {
		const providerKey = candidate.synthesizedProviderKey
		const provider = providerKey
			? collapsedProviders.get(providerKey)
			: undefined
		if (!provider || candidate.type !== 'capability') {
			matches.push(candidate.match)
			continue
		}
		if (!emittedCards.has(provider.key)) {
			matches.push(
				buildProviderCard({ provider, candidates: input.candidates }),
			)
			emittedCards.add(provider.key)
		}
		if (!shouldKeepTaskOperations(input.query, provider)) continue
		const retained = retainedOperationsByProvider.get(provider.key) ?? 0
		if (retained >= maxTaskSpecificProviderOperations) continue
		matches.push(candidate.match)
		retainedOperationsByProvider.set(provider.key, retained + 1)
	}
	return matches
}
