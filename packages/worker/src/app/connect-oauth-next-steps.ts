import { buildForkPrompt } from '#app/community-public.ts'
import { searchCommunityListings } from '#worker/community/service.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import { buildCommunityPublicUrl } from '#mcp/capabilities/community/shared.ts'
import {
	packageIdentityMentionsProvider,
	resolveIntegrationProviderName,
} from '#mcp/tools/integration-package-suggestions.ts'

type ConnectOauthSuggestionProvider = Parameters<
	typeof resolveIntegrationProviderName
>[0]

type CommunityListingProviderIdentity = Pick<
	CommunityListingWithAggregates,
	'kodyId' | 'name' | 'tags'
>

export const connectOauthPackageSuggestionLimit = 3
export const connectOauthCommunitySearchCandidateLimit = 12

export type ConnectOauthPackageSuggestion = {
	listingId: string
	name: string
	kodyId: string
	description: string
	trusted: boolean
	publicUrl: string
	forkPrompt: string
}

export type ConnectOauthCreateHelpersCta = {
	label: string
	prompt: string
}

export type ConnectOauthNextSteps = {
	guidance: string
	integrationName: string
	suggestions: Array<ConnectOauthPackageSuggestion>
	createHelpersCta: ConnectOauthCreateHelpersCta
}

/**
 * Community listings related to a provider. Relevance order is preserved;
 * there is no trusted-listing rank.
 */
export function rankTrustedFirstCommunityListings<
	T extends { trusted: boolean },
>(listings: ReadonlyArray<T>): Array<T> {
	return [...listings]
}

export function buildConnectOauthCreateHelpersPrompt(integrationName: string) {
	return `Create a thin helpers package for the "${integrationName}" OAuth integration. The saved integration is auth credentials only — not an agent-callable API. The helpers package should be the durable agent-facing surface (exports that call the provider with createAuthenticatedFetch from kody:runtime). Open search({ entity: ["package_authoring:guide", "integration_bootstrap:guide"] }), keep a README ## Intent section, and smoke-test with execute before saving.`
}

export function buildConnectOauthNextStepsGuidance(input: {
	integrationName: string
	suggestionCount: number
}) {
	const base = `Connected. "${input.integrationName}" is an OAuth integration (auth credentials only) — not an agent-callable package. Durable agent interaction goes through a helpers package.`
	if (input.suggestionCount <= 0) {
		return `${base} No close community helpers package was found for this provider — create a thin helpers package next.`
	}
	return `${base} Community listings below may help — review them before forking, or create a thin helpers package.`
}

/**
 * Same-provider gate used by MCP integration detail: a listing is related
 * only when its kody id, name, or tags mention the connected provider.
 * Description/README prose is ignored so a trusted Cursor SDK does not
 * surface after a GitHub connect.
 */
export function communityListingUsesProvider(
	listing: CommunityListingProviderIdentity,
	providerName: string,
): boolean {
	return packageIdentityMentionsProvider(
		{
			kodyId: listing.kodyId,
			name: listing.name,
			tags: listing.tags,
		},
		providerName,
	)
}

export function buildConnectOauthPackageSuggestion(input: {
	listing: Pick<
		CommunityListingWithAggregates,
		'id' | 'name' | 'kodyId' | 'description' | 'trusted'
	>
	baseUrl: string
}): ConnectOauthPackageSuggestion {
	return {
		listingId: input.listing.id,
		name: input.listing.name,
		kodyId: input.listing.kodyId,
		description: input.listing.description,
		trusted: input.listing.trusted,
		publicUrl: buildCommunityPublicUrl(input.baseUrl, {
			listingId: input.listing.id,
			name: input.listing.name,
			kodyId: input.listing.kodyId,
		}),
		forkPrompt: buildForkPrompt({
			name: input.listing.name,
			listingId: input.listing.id,
		}),
	}
}

export function buildConnectOauthNextSteps(input: {
	integrationName: string
	providerName?: string
	baseUrl: string
	listings: ReadonlyArray<CommunityListingWithAggregates>
}): ConnectOauthNextSteps {
	const providerName = input.providerName ?? input.integrationName
	const related = input.listings.filter((listing) =>
		communityListingUsesProvider(listing, providerName),
	)
	const suggestions = related
		.slice(0, connectOauthPackageSuggestionLimit)
		.map((listing) =>
			buildConnectOauthPackageSuggestion({
				listing,
				baseUrl: input.baseUrl,
			}),
		)
	return {
		guidance: buildConnectOauthNextStepsGuidance({
			integrationName: input.integrationName,
			suggestionCount: suggestions.length,
		}),
		integrationName: input.integrationName,
		suggestions,
		createHelpersCta: {
			label: 'Create helpers package',
			prompt: buildConnectOauthCreateHelpersPrompt(input.integrationName),
		},
	}
}

/**
 * Bounded community search for post-connect suggestions. Fails open to an empty
 * suggestion list so OAuth connect never blocks on marketplace availability.
 * Search is scoped to the resolved provider and filtered to listings that
 * actually mention that provider in identity fields.
 */
export async function loadConnectOauthNextSteps(input: {
	env: Env
	integrationName: string
	baseUrl: string
	integration: ConnectOauthSuggestionProvider
	providerQuery?: string
}): Promise<ConnectOauthNextSteps> {
	const providerName = resolveIntegrationProviderName({
		...input.integration,
		name: input.integration.name || input.integrationName,
	})
	const query = (input.providerQuery ?? providerName).trim()
	let listings: Array<CommunityListingWithAggregates> = []
	if (query) {
		try {
			listings = await searchCommunityListings({
				env: input.env,
				query,
				limit: connectOauthCommunitySearchCandidateLimit,
				resultFilter: (listing) =>
					communityListingUsesProvider(listing, providerName),
			})
		} catch (error) {
			console.error('Failed to load post-OAuth public package suggestions.', {
				integrationName: input.integrationName,
				query,
				error,
			})
			listings = []
		}
	}
	return buildConnectOauthNextSteps({
		integrationName: input.integrationName,
		providerName,
		baseUrl: input.baseUrl,
		listings,
	})
}
