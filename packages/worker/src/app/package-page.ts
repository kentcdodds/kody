import { loadAccountPackageDetail } from '#app/account-packages-data.ts'
import { loadCommunityDetailData } from '#app/community-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
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
			viewerIsOwner: boolean
			loggedIn: boolean
			invocationUrlOrigin: string
	  }

function isPublicSavedPackage(pkg: { hidden: boolean; isPrivate: boolean }) {
	return !pkg.hidden && !pkg.isPrivate
}

function sameKodyId(left: string, right: string) {
	return left.trim().toLowerCase() === right.trim().toLowerCase()
}

export async function loadPackagePage(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
}): Promise<PackagePageAccess> {
	const target = await resolvePackagePageUrl({
		db: input.env.APP_DB,
		username: input.username,
		kodyId: input.kodyId,
	})
	if (!target) return { kind: 'not_found' }

	const user = await readAuthenticatedAppUser(input.request, input.env)
	const viewerUserId = user?.mcpUser.userId ?? null

	if (target.kind === 'redirect') {
		const viewerOwnsRedirect =
			viewerUserId != null && viewerUserId === target.userId
		// A listing move is public. An unlisted rename must not leak the new
		// pair: only the owner is sent to the current URL.
		if (!target.listingId && !viewerOwnsRedirect) {
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

	const viewerIsOwner = viewerUserId != null && viewerUserId === target.userId
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
		const [listing, ownerPackage] = await Promise.all([
			target.listingId
				? loadCommunityDetailData(input.env, input.request, target.listingId)
				: Promise.resolve(null),
			loadAccountPackageDetail({
				env: input.env,
				requestUrl: input.request.url,
				userId: target.userId,
				packageId: target.savedPackage.id,
			}),
		])
		return {
			kind: 'page',
			username: target.username,
			kodyId: target.kodyId,
			listing,
			ownerPackage,
			viewerIsOwner: true,
			loggedIn: true,
			invocationUrlOrigin,
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
			loggedIn: Boolean(user),
			invocationUrlOrigin,
		}
	}

	if (!target.savedPackage || !isPublicSavedPackage(target.savedPackage)) {
		return { kind: 'not_found' }
	}

	return { kind: 'unauthorized' }
}
