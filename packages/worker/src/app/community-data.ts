import {
	buildForkPrompt,
	toPublicCommunityListing,
	type PublicCommunityListing,
} from '#app/community-public.ts'
import {
	buildCommunityDetailListingCacheKey,
	buildCommunityIndexCacheKey,
	getOrSetDataCache,
} from '#app/data-cache.ts'
import {
	type CommunityDetailLoaderData,
	type CommunityIndexLoaderData,
} from '#app/loader-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { setRequestDataCacheLookup } from '#app/request-cache.ts'
import {
	listCommunityListingsWithAggregates,
	searchCommunityListings,
	getCommunityListingWithAggregates,
} from '#worker/community/service.ts'

const defaultCommunityListLimit = 50

function isCommunityDataCacheEnabled(env: Env) {
	const sentryEnv = (env as { SENTRY_ENVIRONMENT?: string }).SENTRY_ENVIRONMENT
	return sentryEnv !== 'test'
}

async function loadWithCommunityCache<T>(
	env: Env,
	request: Request,
	key: string,
	load: () => Promise<T>,
): Promise<T> {
	if (!isCommunityDataCacheEnabled(env)) {
		setRequestDataCacheLookup(request, 'miss')
		return load()
	}

	const { value, lookup } = await getOrSetDataCache({ key, load })
	setRequestDataCacheLookup(request, lookup)
	return value
}

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
	request: Request,
): Promise<CommunityIndexLoaderData> {
	const url = new URL(request.url)
	const query = url.searchParams.get('q')?.trim() ?? ''
	const limit = readPositiveInt(url.searchParams.get('limit'), {
		defaultValue: defaultCommunityListLimit,
		max: 100,
	})

	const cacheKey = buildCommunityIndexCacheKey({ query, limit })
	const listings = await loadWithCommunityCache(
		env,
		request,
		cacheKey,
		async () => {
			const rows = query
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
			return rows.map(toPublicCommunityListing)
		},
	)

	return {
		ok: true,
		listings,
		query: query || null,
	}
}

export async function loadCommunityDetailData(
	env: Env,
	request: Request,
	listingId: string,
): Promise<CommunityDetailLoaderData | null> {
	const cacheKey = buildCommunityDetailListingCacheKey(listingId)
	const listing = await loadWithCommunityCache(
		env,
		request,
		cacheKey,
		async () => {
			const row = await getCommunityListingWithAggregates({
				env,
				listingId,
				includeDelisted: false,
			})
			if (!row) return null
			return toPublicCommunityListing(row)
		},
	)

	if (!listing) return null

	const user = await readAuthenticatedAppUser(request, env)
	return composeCommunityDetailLoaderData(listing, Boolean(user))
}

export function composeCommunityDetailLoaderData(
	listing: PublicCommunityListing,
	loggedIn: boolean,
): CommunityDetailLoaderData {
	return {
		ok: true,
		listing,
		loggedIn,
		forkPrompt: buildForkPrompt({
			name: listing.name,
			listingId: listing.id,
		}),
	}
}
