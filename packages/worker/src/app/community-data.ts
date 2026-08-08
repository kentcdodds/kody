import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { readPositiveInt } from '#worker/query-params.ts'
import {
	buildForkPrompt,
	toOnboardingFeaturedListing,
	toPublicCommunityListing,
	toViewerListingInstall,
	type OnboardingFeaturedListing,
	type PublicCommunityListing,
	type ViewerListingInstall,
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
} from '#universal/loader-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { setRequestDataCacheLookup } from '#app/request-cache.ts'
import { listCommunityForksByListingIdsAndUser } from '#worker/community/repo.ts'
import {
	listCommunityListingsWithAggregates,
	listFeaturedCommunityListingsWithAggregates,
	searchCommunityListings,
	getCommunityListingWithAggregates,
} from '#worker/community/service.ts'
import {
	getCommunityStar,
	getUserFollow,
	getUserSocialRowByUsername,
} from '#worker/community/social-repo.ts'
import { resolveViewerListingInstalls } from '#worker/community/viewer-install.ts'
import {
	listSavedPackagesByIds,
	listSavedPackagesByKodyIds,
} from '#worker/package-registry/repo.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import { resolveUserStableId } from '#worker/user-id.ts'

const defaultCommunityListLimit = 50
const onboardingFeaturedListingLimit = 12

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

	const user = await readOptionalAuthenticatedViewer(request, env)
	return {
		ok: true,
		listings: await overlayViewerInstallsOnListings({
			env,
			user,
			listings,
		}),
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
		const listings = await loadWithCommunityCache(
			env,
			request,
			cacheKey,
			async () => {
				const rows = await listFeaturedCommunityListingsWithAggregates({
					env,
					limit: onboardingFeaturedListingLimit,
				})
				return rows.map(toOnboardingFeaturedListing)
			},
		)
		const user = await readOptionalAuthenticatedViewer(request, env)
		return overlayViewerInstallsOnListings({
			env,
			user,
			listings,
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

	const ownerRow = await getUserSocialRowByUsername(
		env.APP_DB,
		listing.ownerUsername,
	)
	const ownerProfilePublic = ownerRow?.profile_visibility === 'public'
	const ownerUserId = ownerRow ? resolveUserStableId(ownerRow) : null

	const user = await readOptionalAuthenticatedAppUser(request, env)
	const viewerUserId = user?.mcpUser.userId ?? null
	const viewerIsOwner =
		viewerUserId != null && ownerUserId != null && viewerUserId === ownerUserId
	const [starredByViewer, viewerFollowsOwner, viewerInstalls] =
		await Promise.all([
			user != null
				? getCommunityStar(env.APP_DB, {
						listingId,
						userId: user.mcpUser.userId,
					})
				: false,
			user != null &&
			ownerUserId != null &&
			ownerProfilePublic &&
			!viewerIsOwner
				? getUserFollow(env.APP_DB, {
						followerUserId: user.mcpUser.userId,
						followeeUserId: ownerUserId,
					})
				: false,
			loadViewerListingInstalls({
				env,
				user: user?.mcpUser ?? null,
				listings: [{ id: listing.id, kodyId: listing.kodyId }],
			}),
		])
	const viewerInstall = viewerInstalls.get(listing.id) ?? null
	return composeCommunityDetailLoaderData({
		listing: viewerInstall ? { ...listing, viewerInstall } : listing,
		loggedIn: Boolean(user),
		viewerIsAdmin: user?.roles.includes('admin') ?? false,
		starredByViewer,
		ownerProfilePublic,
		viewerFollowsOwner,
		viewerIsOwner,
		viewerInstall,
	})
}

export function composeCommunityDetailLoaderData(input: {
	listing: PublicCommunityListing
	loggedIn: boolean
	viewerIsAdmin?: boolean
	starredByViewer?: boolean
	ownerProfilePublic?: boolean
	viewerFollowsOwner?: boolean
	viewerIsOwner?: boolean
	viewerInstall?: ViewerListingInstall | null
}): CommunityDetailLoaderData {
	return {
		ok: true,
		listing: input.listing,
		ownerProfilePublic: input.ownerProfilePublic ?? false,
		viewerFollowsOwner: input.viewerFollowsOwner ?? false,
		viewerIsOwner: input.viewerIsOwner ?? false,
		loggedIn: input.loggedIn,
		viewerIsAdmin: input.viewerIsAdmin ?? false,
		forkPrompt: buildForkPrompt({
			name: input.listing.name,
			listingId: input.listing.id,
		}),
		starredByViewer: input.starredByViewer ?? false,
		viewerInstall: input.viewerInstall ?? null,
	}
}

/**
 * Public listing pages stay up when session parsing or user lookup fails.
 * Viewer overlays are optional; anonymous listings are the safe fallback.
 */
async function readOptionalAuthenticatedAppUser(request: Request, env: Env) {
	try {
		return await readAuthenticatedAppUser(request, env)
	} catch (error) {
		console.error('Failed to resolve authenticated viewer for listings:', error)
		return null
	}
}

async function readOptionalAuthenticatedViewer(request: Request, env: Env) {
	return (await readOptionalAuthenticatedAppUser(request, env))?.mcpUser ?? null
}

async function overlayViewerInstallsOnListings<
	T extends { id: string; kodyId: string },
>(input: {
	env: Env
	user: McpUserContext | null
	listings: Array<T>
}): Promise<Array<T>> {
	if (input.user == null || input.listings.length === 0) {
		return input.listings
	}
	const viewerInstalls = await loadViewerListingInstalls({
		env: input.env,
		user: input.user,
		listings: input.listings,
	})
	if (viewerInstalls.size === 0) return input.listings
	return input.listings.map((listing) => {
		const viewerInstall = viewerInstalls.get(listing.id)
		return viewerInstall ? { ...listing, viewerInstall } : listing
	})
}

/**
 * Viewer overlay is per-request and never written into the public listing
 * cache. Failures stay empty so a fork/package lookup blip cannot take down
 * onboarding or community browse.
 */
async function loadViewerListingInstalls(input: {
	env: Env
	user: McpUserContext | null
	listings: Array<{ id: string; kodyId: string }>
}): Promise<Map<string, ViewerListingInstall>> {
	if (input.user == null || input.listings.length === 0) {
		return new Map()
	}
	try {
		const listingIds = input.listings.map((listing) => listing.id)
		const kodyIds = input.listings.map((listing) => listing.kodyId)
		const [packageScope, forks, savedByKody] = await Promise.all([
			getMcpUserPackageScope(input.env.APP_DB, input.user),
			listCommunityForksByListingIdsAndUser(input.env.APP_DB, {
				listingIds,
				userId: input.user.userId,
			}),
			listSavedPackagesByKodyIds(input.env.APP_DB, {
				userId: input.user.userId,
				kodyIds,
			}),
		])
		const missingPackageIds = [
			...new Set(
				forks
					.map((fork) => fork.forkedPackageId)
					.filter(
						(packageId) =>
							!savedByKody.some(
								(savedPackage) => savedPackage.id === packageId,
							),
					),
			),
		]
		const savedByForkId =
			missingPackageIds.length === 0
				? []
				: await listSavedPackagesByIds(input.env.APP_DB, {
						userId: input.user.userId,
						packageIds: missingPackageIds,
					})
		const resolved = resolveViewerListingInstalls({
			listings: input.listings,
			packageScope,
			savedPackages: [...savedByKody, ...savedByForkId],
			forks,
		})
		const viewerInstalls = new Map<string, ViewerListingInstall>()
		for (const [listingId, install] of resolved) {
			viewerInstalls.set(listingId, toViewerListingInstall(install))
		}
		return viewerInstalls
	} catch (error) {
		console.error('Failed to load viewer listing installs:', error)
		return new Map()
	}
}
