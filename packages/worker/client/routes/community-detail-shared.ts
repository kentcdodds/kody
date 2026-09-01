import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'
import { COMMUNITY_DETAIL_TARGET } from '#universal/community-frame-constants.ts'
import { prefetchFrame } from '#client/frame-prefetch.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import {
	type PublicCommunityListing,
	type ViewerListingInstall,
} from '#universal/community-public-types.ts'
import {
	type AccountPackageDetail,
	type AccountPackagesLoaderData,
} from '#universal/loader-data.ts'

export type CommunityDetailApiPayload = {
	ok: true
	listing: PublicCommunityListing | null
	ownerProfilePublic: boolean
	loggedIn: boolean
	viewerIsAdmin: boolean
	viewerIsOwner: boolean
	forkPrompt: string
	viewerInstall: ViewerListingInstall | null
	readmeContent: string | null
	readmeFences?: Array<HighlightedCode>
	ownerPackage: AccountPackageDetail | null
	username: string
	kodyId: string
	isPrivate: boolean
	invocationUrlOrigin: string
}

export type CommunityPackageMovedPayload = {
	ok: false
	// The canonical pair the requested one was renamed to.
	redirectTo?: string
}

export type CommunityInstallApiPayload = {
	ok: boolean
	requiresAcknowledgement?: boolean
	status?: 'installed' | 'adaptation_required'
	packageId?: string
	targetName?: string
	agentPrompt?: string
	failedChecks?: Array<{ kind: string; message: string }>
	error?: string
}

export type CommunityShellSnapshot = {
	loggedIn: boolean
	viewerIsAdmin: boolean
	viewerIsOwner: boolean
	trusted: boolean
	featured: boolean
	readmeContent: string | null
	readmeFences?: Array<HighlightedCode> | undefined
	ownerPackage: AccountPackageDetail | null
	username: string
	kodyId: string
	isPrivate: boolean
	invocationUrlOrigin: string
}

export type CommunityInstallOutcome = {
	status: 'installed' | 'adaptation_required'
	targetName: string
	agentPrompt: string
	packageId: string | null
	failedChecks: Array<{ kind: string; message: string }>
}

export function getListingIdFromPathname(pathname: string) {
	const prefix = `${routes.community.href()}/`
	if (!pathname.startsWith(prefix)) return null
	let listingId: string
	try {
		listingId = decodeURIComponent(
			pathname.slice(prefix.length).replace(/\/$/, ''),
		)
	} catch {
		// Malformed percent-encoding (`/community/%`) throws. The shell calls
		// this to classify every pathname, so a throw here would take the whole
		// page down instead of just missing a listing.
		return null
	}
	return listingId || null
}

const communityPackageMatcher = createMatcher(routes.communityPackage.pattern)
const communityPackageSettingsMatcher = createMatcher(
	routes.communityPackageSettings.pattern,
)

/**
 * The canonical package URL (`/@owner/kody-id`) carries no listing id, and
 * every listing-scoped API is keyed by it. The server resolves the pair once
 * per page load (route loader or SSR shell); remembering the answer here keeps
 * the action handlers able to read the id synchronously.
 *
 * Module scope is shared by every request in a worker isolate (the app shell
 * imports this module for SSR too), so the cache is bounded: it only ever needs
 * the page being rendered plus the handful a visitor navigated through, and an
 * entry evicted early costs a refetch, not correctness.
 */
const listingIdsByPathname = new Map<string, string>()
const maxRememberedListingPathnames = 10

export function rememberListingId(pathname: string, listingId: string) {
	// Re-setting moves the entry to the end of the insertion order, so the
	// oldest key is always the least recently resolved one.
	listingIdsByPathname.delete(pathname)
	listingIdsByPathname.set(pathname, listingId)
	for (const key of listingIdsByPathname.keys()) {
		if (listingIdsByPathname.size <= maxRememberedListingPathnames) break
		listingIdsByPathname.delete(key)
	}
}

export type ListingPageRef = {
	pathname: string
	detailApiHref: string
	listingId: string | null
}

export function getListingPageRef(pathname: string): ListingPageRef | null {
	const listingId = getListingIdFromPathname(pathname)
	if (listingId) {
		return {
			pathname,
			detailApiHref: routes.communityDetailApi.href({ listingId }),
			listingId,
		}
	}

	const params = communityPackageMatcher.match(
		new URL(pathname, 'http://localhost'),
	)?.params
	if (!params) return null
	return {
		pathname,
		detailApiHref: routes.communityPackageApi.href({
			username: params.username,
			kodyId: params.kodyId,
		}),
		listingId: listingIdsByPathname.get(pathname) ?? null,
	}
}

export function getPackageSettingsPageRef(
	pathname: string,
): ListingPageRef | null {
	const params = communityPackageSettingsMatcher.match(
		new URL(pathname, 'http://localhost'),
	)?.params
	if (!params) return null
	return {
		pathname,
		detailApiHref: routes.communityPackageApi.href({
			username: params.username,
			kodyId: params.kodyId,
		}),
		listingId: listingIdsByPathname.get(pathname) ?? null,
	}
}

export function getPackageDetailApiRef(
	pathname: string,
): ListingPageRef | null {
	return getListingPageRef(pathname) ?? getPackageSettingsPageRef(pathname)
}

export function packageMoveDestination(pathname: string, movedTo: string) {
	return getPackageSettingsPageRef(pathname) ? `${movedTo}/settings` : movedTo
}

/**
 * True for the package home (`/@owner/kody-id`), its listing-uuid fallback,
 * and owner settings (`/@owner/kody-id/settings`).
 */
export function isCommunityListingPathname(pathname: string) {
	return getPackageDetailApiRef(pathname) !== null
}

export function buildCommunityDetailFrameSrc(href: string) {
	const url = new URL(href, 'http://localhost')
	if (!getListingPageRef(url.pathname)) return url.pathname
	return url.pathname
}

export async function communityDetailRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const ref = getPackageDetailApiRef(url.pathname)
	if (!ref) {
		throw new Error('Community listing not found.')
	}

	const frameSrc = buildCommunityDetailFrameSrc(`${url.pathname}${url.search}`)
	const shellPromise = fetch(ref.detailApiHref, {
		headers: { Accept: 'application/json' },
		signal,
	})
	const framePrefetchPromise = prefetchFrame(
		frameSrc,
		COMMUNITY_DETAIL_TARGET,
		signal,
	)

	const response = await shellPromise
	const payload = await readJson<
		CommunityDetailApiPayload | CommunityPackageMovedPayload
	>(response)
	if (response.status === 401) {
		return {
			communityDetailShell: { ok: false, unauthorized: true },
		}
	}
	if (response.status === 404) {
		const movedTo = payload && !payload.ok ? payload.redirectTo : null
		// A renamed package is a real destination, not a dead link: leave the SPA
		// so the visitor lands on (and can copy) the canonical URL.
		if (movedTo) {
			return routeLoaderRedirect(packageMoveDestination(url.pathname, movedTo))
		}
		throw new Error('Community listing not found.')
	}
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load public package.')
	}
	if (getPackageSettingsPageRef(url.pathname)) {
		if (!payload.viewerIsOwner || !payload.ownerPackage) {
			throw new Error('Community listing not found.')
		}
	}

	await framePrefetchPromise
	const listingId = payload.listing?.id ?? null
	if (listingId) rememberListingId(ref.pathname, listingId)

	return {
		communityDetailShell: {
			ok: true,
			listingId,
			name: payload.listing?.name ?? payload.ownerPackage?.name ?? '',
			description:
				payload.listing?.description ?? payload.ownerPackage?.description ?? '',
			forkPrompt: payload.forkPrompt,
			loggedIn: payload.loggedIn,
			viewerIsAdmin: payload.viewerIsAdmin,
			viewerIsOwner: payload.viewerIsOwner,
			trusted: payload.listing?.trusted ?? false,
			featured: payload.listing?.featured ?? false,
			readmeContent:
				payload.readmeContent ?? payload.listing?.readmeContent ?? null,
			readmeFences: payload.readmeFences,
			viewerInstall: payload.viewerInstall,
			ownerPackage: payload.ownerPackage,
			username: payload.username,
			kodyId:
				payload.kodyId ||
				payload.listing?.kodyId ||
				payload.ownerPackage?.kodyId ||
				'',
			isPrivate: payload.isPrivate ?? payload.ownerPackage?.isPrivate ?? false,
			invocationUrlOrigin: payload.invocationUrlOrigin,
		},
	}
}

export type PackageLockResult =
	| { status: 'unauthorized' }
	| {
			status: 'ok'
			lockedAt: string | null
			selectedPackage: AccountPackageDetail | null
	  }
	| { status: 'error'; message: string }

export async function postPackageLock(
	packageId: string,
	nextLocked: boolean,
): Promise<PackageLockResult> {
	try {
		const response = await fetch('/account/packages.json', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			credentials: 'include',
			body: JSON.stringify({
				action: nextLocked ? 'lock' : 'unlock',
				packageId,
			}),
		})
		if (response.status === 401) {
			return { status: 'unauthorized' }
		}
		const payload = await readJson<
			AccountPackagesLoaderData & { error?: string }
		>(response)
		if (!response.ok || !payload?.ok) {
			return {
				status: 'error',
				message: payload?.error ?? 'Could not update the publish lock.',
			}
		}
		return {
			status: 'ok',
			lockedAt: payload.selectedPackage?.lockedAt ?? null,
			selectedPackage: payload.selectedPackage ?? null,
		}
	} catch {
		return { status: 'error', message: 'Could not update the publish lock.' }
	}
}

export function buildReportApiPath(listingId: string) {
	return routes.communityReportApiPost.href({ listingId })
}
