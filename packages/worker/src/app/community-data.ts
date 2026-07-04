import { toPublicCommunityListing } from '#app/community-public.ts'
import {
	type CommunityDetailLoaderData,
	type CommunityIndexLoaderData,
} from '#app/loader-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { buildForkPrompt } from '#app/community-public.ts'
import {
	listCommunityListingsWithAggregates,
	searchCommunityListings,
	getCommunityListingWithAggregates,
} from '#worker/community/service.ts'

const defaultCommunityListLimit = 50

function readPositiveInt(
	value: string | null,
	input: { defaultValue: number; max: number },
) {
	if (!value) return input.defaultValue
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) return input.defaultValue
	return Math.min(parsed, input.max)
}

export async function loadCommunityIndexData(
	env: Env,
	requestUrl: string,
): Promise<CommunityIndexLoaderData> {
	const url = new URL(requestUrl, 'http://localhost')
	const query = url.searchParams.get('q')?.trim() ?? ''
	const limit = readPositiveInt(url.searchParams.get('limit'), {
		defaultValue: defaultCommunityListLimit,
		max: 100,
	})

	const listings = query
		? await searchCommunityListings({
				env,
				query,
				limit,
			})
		: await listCommunityListingsWithAggregates({
				env,
				includeDelisted: false,
				limit,
				offset: 0,
			})

	return {
		ok: true,
		listings: listings.map(toPublicCommunityListing),
		query: query || null,
	}
}

export async function loadCommunityDetailData(
	env: Env,
	request: Request,
	listingId: string,
): Promise<CommunityDetailLoaderData | null> {
	const listing = await getCommunityListingWithAggregates({
		env,
		listingId,
		includeDelisted: false,
	})
	if (!listing) return null

	const user = await readAuthenticatedAppUser(request, env)
	return {
		ok: true,
		listing: toPublicCommunityListing(listing),
		loggedIn: Boolean(user),
		forkPrompt: buildForkPrompt({
			name: listing.name,
			listingId: listing.id,
		}),
	}
}
