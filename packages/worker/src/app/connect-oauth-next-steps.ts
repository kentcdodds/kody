import { buildForkPrompt } from '#app/community-public.ts'
import { searchCommunityListings } from '#worker/community/service.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'
import { buildCommunityPublicUrl } from '#mcp/capabilities/community/shared.ts'

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
 * Prefer trusted listings while preserving the incoming relevance order within
 * each trust group. Callers should pass score-ranked search results.
 */
export function rankTrustedFirstCommunityListings<
	T extends { trusted: boolean },
>(listings: ReadonlyArray<T>): Array<T> {
	const trusted: Array<T> = []
	const untrusted: Array<T> = []
	for (const listing of listings) {
		if (listing.trusted) {
			trusted.push(listing)
		} else {
			untrusted.push(listing)
		}
	}
	return [...trusted, ...untrusted]
}

export function buildConnectOauthCreateHelpersPrompt(integrationName: string) {
	return `Create a thin helpers package for the "${integrationName}" OAuth integration. The saved integration is auth credentials only — not an agent-callable API. The helpers package should be the durable agent-facing surface (exports that call the provider with refreshAccessToken / createAuthenticatedFetch from kody:runtime). Load coding_guide_get({ guide: "package_authoring" }) and coding_guide_get({ guide: "integration_bootstrap" }), keep a README ## Intent section, and smoke-test with execute before saving.`
}

export function buildConnectOauthNextStepsGuidance(input: {
	integrationName: string
	suggestionCount: number
	trustedSuggestionCount: number
}) {
	const base = `Connected. "${input.integrationName}" is an OAuth integration (auth credentials only) — not an agent-callable package. Durable agent interaction goes through a helpers package.`
	if (input.suggestionCount <= 0) {
		return `${base} No close community helpers package was found for this provider — create a thin helpers package next.`
	}
	if (input.trustedSuggestionCount > 0) {
		return `${base} Prefer a trusted community listing below (fork or one-click install, then adapt). Create a thin helpers package only when none of these fit.`
	}
	return `${base} Community listings below may help, but none are trusted yet — review carefully before forking, or create a thin helpers package.`
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
		publicUrl: buildCommunityPublicUrl(input.baseUrl, input.listing.id),
		forkPrompt: buildForkPrompt({
			name: input.listing.name,
			listingId: input.listing.id,
		}),
	}
}

export function buildConnectOauthNextSteps(input: {
	integrationName: string
	baseUrl: string
	listings: ReadonlyArray<CommunityListingWithAggregates>
}): ConnectOauthNextSteps {
	const ranked = rankTrustedFirstCommunityListings(input.listings).slice(
		0,
		connectOauthPackageSuggestionLimit,
	)
	const suggestions = ranked.map((listing) =>
		buildConnectOauthPackageSuggestion({
			listing,
			baseUrl: input.baseUrl,
		}),
	)
	return {
		guidance: buildConnectOauthNextStepsGuidance({
			integrationName: input.integrationName,
			suggestionCount: suggestions.length,
			trustedSuggestionCount: suggestions.filter(
				(suggestion) => suggestion.trusted,
			).length,
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
 */
export async function loadConnectOauthNextSteps(input: {
	env: Env
	integrationName: string
	baseUrl: string
	providerQuery?: string
}): Promise<ConnectOauthNextSteps> {
	const query = (input.providerQuery ?? input.integrationName).trim()
	let listings: Array<CommunityListingWithAggregates> = []
	if (query) {
		try {
			listings = await searchCommunityListings({
				env: input.env,
				query,
				limit: connectOauthCommunitySearchCandidateLimit,
			})
		} catch (error) {
			console.error(
				'Failed to load post-OAuth community package suggestions.',
				{
					integrationName: input.integrationName,
					query,
					error,
				},
			)
			listings = []
		}
	}
	return buildConnectOauthNextSteps({
		integrationName: input.integrationName,
		baseUrl: input.baseUrl,
		listings,
	})
}
