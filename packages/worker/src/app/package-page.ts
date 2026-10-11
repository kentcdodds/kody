import { loadAccountPackageDetail } from '#app/account-packages-data.ts'
import { loadCommunityDetailData } from '#app/community-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { viewerCanReadSavedPackage } from '#app/package-viewer-access.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { getUserSocialRowByUsername } from '#worker/community/profile-repo.ts'
import {
	memoizePerRequest,
	recordServerTiming,
} from '#worker/request-context.ts'
import {
	getCommunityPackageHref,
	resolvePackagePageUrl,
} from '#worker/community/package-url.ts'
import {
	type AccountPackageDetail,
	type CommunityDetailLoaderData,
} from '#universal/loader-data.ts'

export type PackagePageAccess =
	| { kind: 'redirect'; to: string; shared: boolean }
	| { kind: 'not_found' }
	| { kind: 'unauthorized' }
	| {
			kind: 'page'
			username: string
			kodyId: string
			listing: CommunityDetailLoaderData | null
			ownerPackage: AccountPackageDetail | null
			/** The viewer may open the private view (details, source files). */
			viewerIsOwner: boolean
			/**
			 * The viewer may change the package (settings, publish). The account
			 * package APIs act on the caller's own org, so only packages that org
			 * owns are manageable here.
			 */
			viewerCanManage: boolean
			loggedIn: boolean
			invocationUrlOrigin: string
			ownerUserId: string
			/** True when `/@owner` is publicly reachable. */
			ownerProfilePublic: boolean
	  }

export type PackagePagePrivacySource = {
	ownerPackage: { isPrivate: boolean } | null
}

export function packagePageIsPrivate(page: PackagePagePrivacySource): boolean {
	return page.ownerPackage?.isPrivate ?? false
}

function isPublicSavedPackage(pkg: { hidden: boolean; isPrivate: boolean }) {
	return !pkg.hidden && !pkg.isPrivate
}

async function resolvePackagePageOwnerProfilePublic(input: {
	env: Env
	username: string
	listing: CommunityDetailLoaderData | null
}) {
	if (typeof input.listing?.ownerProfilePublic === 'boolean') {
		return input.listing.ownerProfilePublic
	}
	const row = await getUserSocialRowByUsername(input.env.APP_DB, input.username)
	return row?.profile_visibility === 'public'
}

function sameKodyId(left: string, right: string) {
	return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/**
 * One SSR request resolves the same package several times: the page handler,
 * the `community-detail` frame rendered while the response streams, and the
 * files loader that gates on the same access decision. Memoize per request so
 * the URL resolution, auth, and detail loads run once.
 */
export function loadPackagePage(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
}): Promise<PackagePageAccess> {
	return memoizePerRequest({
		request: input.request,
		key: `package-page:${input.username}:${input.kodyId}`,
		load: () =>
			recordServerTiming(
				'package-page',
				() => loadPackagePageUncached(input),
				input.request,
			),
	})
}

async function loadPackagePageUncached(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
}): Promise<PackagePageAccess> {
	// The URL lookup only needs the pair; the viewer lookup only needs the
	// cookie. Neither waits on the other.
	const [target, user] = await Promise.all([
		recordServerTiming(
			'resolve-url',
			() =>
				resolvePackagePageUrl({
					db: input.env.APP_DB,
					username: input.username,
					kodyId: input.kodyId,
				}),
			input.request,
		),
		recordServerTiming(
			'auth',
			() => readAuthenticatedAppUser(input.request, input.env),
			input.request,
		),
	])
	if (!target) return { kind: 'not_found' }

	const viewer = user?.mcpUser ?? null

	if (target.kind === 'redirect') {
		// A listing move is public. An unlisted rename must not leak the new
		// pair: only viewers who can see the package are sent to the current URL.
		if (
			!target.listingId &&
			!(await viewerCanReadSavedPackage({
				env: input.env,
				viewer,
				ownerId: target.userId,
				packageId: target.packageId,
			}))
		) {
			return { kind: 'not_found' }
		}
		const listingKodyId = target.listingKodyId
		const shared =
			Boolean(target.listingId) &&
			(listingKodyId == null || sameKodyId(target.kodyId, listingKodyId))
		return {
			kind: 'redirect',
			to: getCommunityPackageHref({
				username: target.username,
				kodyId: target.kodyId,
			}),
			// Shared caches may only store hops to the listing public pair.
			shared,
		}
	}

	const viewerIsOwner = target.savedPackage
		? await viewerCanReadSavedPackage({
				env: input.env,
				viewer,
				ownerId: target.userId,
				packageId: target.savedPackage.id,
			})
		: false
	const listingKodyId = target.listingKodyId
	const savedKodyId = target.savedPackage?.kodyId ?? null
	if (listingKodyId && savedKodyId && !sameKodyId(listingKodyId, savedKodyId)) {
		// Listing kody_id lags a local rename until republish. Owners may
		// hop to the unpublished pair; visitors stay on (or return to) the
		// listing URL.
		if (viewerIsOwner && sameKodyId(input.kodyId, listingKodyId)) {
			return {
				kind: 'redirect',
				to: getCommunityPackageHref({
					username: target.username,
					kodyId: savedKodyId,
				}),
				shared: false,
			}
		}
		if (!viewerIsOwner && sameKodyId(input.kodyId, savedKodyId)) {
			return {
				kind: 'redirect',
				to: getCommunityPackageHref({
					username: target.username,
					kodyId: listingKodyId,
				}),
				shared: true,
			}
		}
	}
	const invocationUrlOrigin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})

	if (viewerIsOwner && target.savedPackage) {
		const viewerCanManage =
			user != null &&
			ownerIdFromCaller({ request: user.request, user: user.mcpUser }) ===
				target.userId
		const [listing, ownerPackage] = await Promise.all([
			target.listingId
				? loadCommunityDetailData(input.env, input.request, target.listingId)
				: Promise.resolve(null),
			loadAccountPackageDetail({
				env: input.env,
				requestUrl: input.request.url,
				userId: target.userId,
				...(viewerCanManage
					? { creditAttributionUsername: target.username }
					: {}),
				packageId: target.savedPackage.id,
			}),
		])
		const ownerProfilePublic = await resolvePackagePageOwnerProfilePublic({
			env: input.env,
			username: target.username,
			listing,
		})
		return {
			kind: 'page',
			username: target.username,
			kodyId: target.kodyId,
			listing,
			ownerPackage,
			viewerIsOwner: true,
			viewerCanManage,
			loggedIn: true,
			invocationUrlOrigin,
			ownerUserId: target.userId,
			ownerProfilePublic,
		}
	}

	if (target.listingId) {
		const listing = await loadCommunityDetailData(
			input.env,
			input.request,
			target.listingId,
		)
		if (!listing) return { kind: 'not_found' }
		return {
			kind: 'page',
			username: target.username,
			kodyId: target.kodyId,
			listing,
			ownerPackage: null,
			viewerIsOwner: false,
			viewerCanManage: false,
			loggedIn: Boolean(user),
			invocationUrlOrigin,
			ownerUserId: target.userId,
			ownerProfilePublic: listing.ownerProfilePublic,
		}
	}

	if (!target.savedPackage || !isPublicSavedPackage(target.savedPackage)) {
		return { kind: 'not_found' }
	}

	return { kind: 'unauthorized' }
}
