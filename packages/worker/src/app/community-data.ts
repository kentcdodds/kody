import { readPositiveInt } from '#app/query-params.ts'
import {
	buildForkPrompt,
	toOnboardingFeaturedListing,
	toPublicCommunityListing,
	type OnboardingFeaturedListing,
	type PublicCommunityListing,
} from '#app/community-public.ts'
import {
	buildCommunityDetailListingCacheKey,
	buildCommunityFeaturedCacheKey,
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
	listFeaturedCommunityListingsWithAggregates,
	searchCommunityListings,
	getCommunityListingWithAggregates,
} from '#worker/community/service.ts'

const defaultCommunityListLimit = 50
const onboardingFeaturedListingLimit = 6

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

export async function loadCommunityIndexData(
	env: Env,
	request: Request,
): Promise<CommunityIndexLoaderData> {
	const url = new URL(request.url)
	const query = url.searchParams.get('q')?.trim() ?? ''
	const limit = readPositiveInt(
		url.searchParams.get('limit'),
		defaultCommunityListLimit,
		100,
	)

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

/**
 * Featured starter packages for the onboarding page. Fails open to an empty
 * list: onboarding must render even if the community tables are unavailable.
 */
export async function loadOnboardingFeaturedListings(
	env: Env,
	request: Request,
): Promise<Array<OnboardingFeaturedListing>> {
	const cacheKey = buildCommunityFeaturedCacheKey(
		onboardingFeaturedListingLimit,
	)
	try {
		return await loadWithCommunityCache(env, request, cacheKey, async () => {
			const rows = await listFeaturedCommunityListingsWithAggregates({
				env,
				limit: onboardingFeaturedListingLimit,
			})
			return rows.map(toOnboardingFeaturedListing)
		})
	} catch (error) {
		console.error('Failed to load onboarding featured listings:', error)
		return []
	}
}

// One SSR request loads detail data twice: once in the HTML handler for the
// loaderData embed and once in the frame renderer during streaming. Memoize
// per Request so the second call reuses the first load.
const requestDetailDataStore = new WeakMap<
	Request,
	Map<string, Promise<CommunityDetailLoaderData | null>>
>()

export function loadCommunityDetailData(
	env: Env,
	request: Request,
	listingId: string,
): Promise<CommunityDetailLoaderData | null> {
	let byListingId = requestDetailDataStore.get(request)
	if (!byListingId) {
		byListingId = new Map()
		requestDetailDataStore.set(request, byListingId)
	}
	let pending = byListingId.get(listingId)
	if (!pending) {
		pending = loadCommunityDetailDataUncached(env, request, listingId)
		byListingId.set(listingId, pending)
	}
	return pending
}

async function loadCommunityDetailDataUncached(
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
	return composeCommunityDetailLoaderData(
		listing,
		Boolean(user),
		user?.roles.includes('admin') ?? false,
	)
}

export function composeCommunityDetailLoaderData(
	listing: PublicCommunityListing,
	loggedIn: boolean,
	viewerIsAdmin = false,
): CommunityDetailLoaderData {
	return {
		ok: true,
		listing,
		loggedIn,
		viewerIsAdmin,
		forkPrompt: buildForkPrompt({
			name: listing.name,
			listingId: listing.id,
		}),
	}
}
