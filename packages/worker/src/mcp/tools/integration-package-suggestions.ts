import { buildCommunityPublicUrl } from '#mcp/capabilities/community/shared.ts'
import { getDomain } from 'tldts'
import {
	canonicalIntegrationName,
	type IntegrationConfig,
} from '#mcp/capabilities/integrations/integration-shared.ts'
import { searchCommunityListings } from '#worker/community/service.ts'
import { type RelatedIntegrationPackageSuggestion } from './search-format.ts'
import { extractSearchTokens } from './understand-search-query.ts'

export const maxIntegrationPackageSuggestions = 3
const communitySuggestionCandidateLimit = 12

type IntegrationProviderMetadata = Pick<
	IntegrationConfig,
	'name' | 'tokenUrl' | 'apiBaseUrl' | 'requiredHosts' | 'authorization'
>

type ProviderPackageIdentity = {
	kodyId: string
	name: string
	tags: ReadonlyArray<string>
}

type SuggestionPackageRow = {
	record: {
		kodyId: string
		name: string
		description: string
		tags: Array<string>
	}
}

function providerMetadataHosts(
	integration: IntegrationProviderMetadata,
): Array<string> {
	const urls = [
		integration.tokenUrl,
		integration.apiBaseUrl,
		integration.authorization?.authorizeUrl,
	]
	const hosts = urls.flatMap((url) => {
		if (!url) return []
		try {
			return [new URL(url).hostname]
		} catch {
			return []
		}
	})
	return [...hosts, ...(integration.requiredHosts ?? [])]
}

const providerDomainAliases: Readonly<Record<string, string>> = {
	googleapis: 'google',
}

function normalizeProviderDomainLabel(label: string): string {
	return providerDomainAliases[label] ?? label
}

function providerTokensFromHost(host: string): Array<string> {
	const registrableDomain = getDomain(host) ?? host.toLowerCase()
	const providerLabel = registrableDomain.split('.')[0] ?? registrableDomain
	return extractSearchTokens(normalizeProviderDomainLabel(providerLabel))
}

/**
 * Separate the provider identity from an account-specific integration label.
 * A prefix is accepted only when saved endpoint metadata independently
 * identifies every token, so an arbitrary first segment is never assumed to be
 * the provider. The full integration name is the safe fallback.
 */
export function resolveIntegrationProviderName(
	integration: IntegrationProviderMetadata,
): string {
	const integrationName = canonicalIntegrationName(integration.name)
	const nameSegments = integrationName.split('-').filter(Boolean)
	const providerTokenGroups = providerMetadataHosts(integration)
		.map(providerTokensFromHost)
		.filter((tokens) => tokens.length > 0)

	const matchesProviderTokens = (tokens: Array<string>) =>
		providerTokenGroups.some(
			(providerTokens) =>
				providerTokens.length === tokens.length &&
				providerTokens.every((token, index) => token === tokens[index]),
		)

	for (let length = nameSegments.length; length > 0; length--) {
		const prefix = nameSegments.slice(0, length).join('-')
		if (matchesProviderTokens(extractSearchTokens(prefix))) {
			return prefix
		}
	}
	return integrationName
}

export function packageIdentityMentionsProvider(
	identity: ProviderPackageIdentity,
	providerName: string,
): boolean {
	const provider = canonicalIntegrationName(providerName)
	const providerTokens = extractSearchTokens(provider)
	if (providerTokens.length === 0) return false

	const identityTokens = new Set(
		extractSearchTokens(
			[identity.kodyId, identity.name, identity.tags.join(' ')].join('\n'),
		),
	)
	return providerTokens.every((token) => identityTokens.has(token))
}

function toUserSuggestion(
	row: SuggestionPackageRow,
): RelatedIntegrationPackageSuggestion {
	return {
		source: 'user',
		kodyId: row.record.kodyId,
		name: row.record.name,
		description: row.record.description,
		entityRef: `${row.record.kodyId}:package`,
	}
}

function toCommunitySuggestion(input: {
	listing: Awaited<ReturnType<typeof searchCommunityListings>>[number]
	baseUrl: string
}): RelatedIntegrationPackageSuggestion {
	return {
		source: 'community',
		kodyId: input.listing.kodyId,
		name: input.listing.name,
		description: input.listing.description,
		listingId: input.listing.id,
		publicUrl: buildCommunityPublicUrl(input.baseUrl, input.listing.id),
		trusted: input.listing.trusted,
	}
}

function collectSameProviderUserSuggestions(
	packageRows: ReadonlyArray<SuggestionPackageRow>,
	providerName: string,
): Array<RelatedIntegrationPackageSuggestion> {
	const suggestions: Array<RelatedIntegrationPackageSuggestion> = []
	for (const row of packageRows) {
		if (
			!packageIdentityMentionsProvider(
				{
					kodyId: row.record.kodyId,
					name: row.record.name,
					tags: row.record.tags,
				},
				providerName,
			)
		) {
			continue
		}
		suggestions.push(toUserSuggestion(row))
		if (suggestions.length >= maxIntegrationPackageSuggestions) break
	}
	return suggestions
}

async function collectSameProviderCommunitySuggestions(input: {
	env: Env
	baseUrl: string
	providerName: string
}): Promise<Array<RelatedIntegrationPackageSuggestion>> {
	const provider = canonicalIntegrationName(input.providerName)
	let listings: Awaited<ReturnType<typeof searchCommunityListings>>
	try {
		listings = await searchCommunityListings({
			env: input.env,
			query: provider,
			limit: communitySuggestionCandidateLimit,
			trustedFirst: true,
			resultFilter: (listing) =>
				packageIdentityMentionsProvider(
					{
						kodyId: listing.kodyId,
						name: listing.name,
						tags: listing.tags,
					},
					provider,
				),
		})
	} catch {
		return []
	}

	const sameProvider = listings.filter((listing) =>
		packageIdentityMentionsProvider(
			{
				kodyId: listing.kodyId,
				name: listing.name,
				tags: listing.tags,
			},
			provider,
		),
	)
	const trusted = sameProvider.filter((listing) => listing.trusted)
	const untrusted = sameProvider.filter((listing) => !listing.trusted)
	const ordered = [...trusted, ...untrusted].slice(
		0,
		maxIntegrationPackageSuggestions,
	)
	return ordered.map((listing) =>
		toCommunitySuggestion({ listing, baseUrl: input.baseUrl }),
	)
}

/**
 * Detail-only helper: suggest same-provider packages for an integration.
 * Prefers the user's own packages and skips community lookup when any exist.
 * Community suggestions are trusted-first and capped.
 */
export async function collectIntegrationPackageSuggestions(input: {
	env: Env
	baseUrl: string
	integration: IntegrationProviderMetadata
	packageRows: ReadonlyArray<SuggestionPackageRow>
}): Promise<Array<RelatedIntegrationPackageSuggestion>> {
	const providerName = resolveIntegrationProviderName(input.integration)
	const userSuggestions = collectSameProviderUserSuggestions(
		input.packageRows,
		providerName,
	)
	if (userSuggestions.length > 0) {
		return userSuggestions
	}
	return await collectSameProviderCommunitySuggestions({
		env: input.env,
		baseUrl: input.baseUrl,
		providerName,
	})
}
