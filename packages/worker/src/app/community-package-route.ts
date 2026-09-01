import { createMatcher } from 'remix/route-pattern/match'
import { loadPackagePage } from '#app/package-page.ts'
import {
	getCommunityPackageHref,
	resolveCommunityPackageUrl,
} from '#worker/community/package-url.ts'
import {
	fallbackDefaultBranchName,
	getCommunityPackageFilesHref,
	getPackageTreeHref,
	isPublicTreeDefaultRefAlias,
	isReservedPackageFilesKodyId,
	normalizePackageFilesPath,
} from '#universal/package-files.ts'
import { getCommunityListingById } from '#worker/community/repo.ts'
import { resolveArtifactSourceHead } from '#worker/repo/artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { routes } from '#universal/routes.ts'

const communityDetailMatcher = createMatcher(routes.communityDetail.pattern)
const communityPackageMatcher = createMatcher(routes.communityPackage.pattern)

export type CommunityListingRouteTarget =
	| { kind: 'listing'; listingId: string }
	// The URL is stale (a rename moved it) and the visitor belongs at `to`.
	| { kind: 'redirect'; to: string }

/**
 * Resolve a listing page URL in either public shape: the canonical
 * `/@owner/kody-id` and the listing-uuid `/community/:listingId` it replaced.
 * Shared by the page handlers, the JSON companions, and the frame renderer so
 * one URL never resolves differently depending on which entered it.
 */
export async function resolveCommunityListingRoute(input: {
	env: Env
	url: URL
}): Promise<CommunityListingRouteTarget | null> {
	const listingId = communityDetailMatcher.match(input.url)?.params.listingId
	if (listingId) return { kind: 'listing', listingId }

	const params = communityPackageMatcher.match(input.url)?.params
	if (!params) return null

	const target = await resolveCommunityPackageUrl({
		db: input.env.APP_DB,
		username: params.username,
		kodyId: params.kodyId,
	})
	if (!target) return null
	if (target.kind === 'redirect') {
		return { kind: 'redirect', to: getCommunityPackageHref(target) }
	}
	return { kind: 'listing', listingId: target.listingId }
}

/**
 * The canonical path for a listing, or null when the owner/`kody.id` pair does
 * not lead back to it. The owner half comes from the listing's scoped name,
 * which a failed republish can leave stale, so a caller redirecting permanently
 * has to know the destination actually resolves — a cached redirect to a 404
 * would outlive the data fix.
 */
export async function resolveCanonicalListingPath(input: {
	env: Env
	listingId: string
	ownerUsername: string
	kodyId: string
}): Promise<string | null> {
	const target = await resolveCommunityPackageUrl({
		db: input.env.APP_DB,
		username: input.ownerUsername,
		kodyId: input.kodyId,
	})
	if (target?.listingId !== input.listingId) return null
	return getCommunityPackageHref(target)
}

const communityDetailFilesMatcher = createMatcher(
	routes.communityDetailFiles.pattern,
)
const communityPackageFilesMatcher = createMatcher(
	routes.communityPackageFiles.pattern,
)
const communityPackageTreeMatcher = createMatcher(
	routes.communityPackageTree.pattern,
)

export type CommunityFilesRouteTarget =
	| {
			kind: 'listing'
			listingId: string
			selectedPath: string
			ref: string
	  }
	| {
			kind: 'package'
			username: string
			kodyId: string
			selectedPath: string
			ref: string
	  }
	| { kind: 'redirect'; to: string; shared: boolean }
	| { kind: 'unauthorized' }
	| { kind: 'invalid-path' }

function filesPathRedirect(
	to: string,
	shared: boolean,
): CommunityFilesRouteTarget {
	return { kind: 'redirect', to, shared }
}

function selectedPathFromParams(relativePath: string | undefined) {
	return normalizePackageFilesPath(relativePath ?? '')
}

function requestedTreeRef(ref: string | undefined) {
	return ref?.trim() ?? ''
}

async function resolveSourceDefaultTreeRef(env: Env, sourceId: string | null) {
	if (!sourceId) return fallbackDefaultBranchName
	try {
		const source = await getEntitySourceById(env.APP_DB, sourceId)
		if (!source?.repo_id) return fallbackDefaultBranchName
		const head = await resolveArtifactSourceHead(env, source.repo_id)
		const branch = head.branch?.trim()
		return branch || fallbackDefaultBranchName
	} catch {
		return fallbackDefaultBranchName
	}
}

async function resolveListingDefaultTreeRef(env: Env, listingId: string) {
	try {
		const listing = await getCommunityListingById(env.APP_DB, {
			listingId,
			includeDelisted: false,
		})
		return resolveSourceDefaultTreeRef(env, listing?.sourceId ?? null)
	} catch {
		return fallbackDefaultBranchName
	}
}

export function treeHrefFromPackageHome(
	packageHref: string,
	input: { ref?: string; relativePath?: string },
) {
	const match = communityPackageMatcher.match(
		new URL(packageHref, 'http://localhost'),
	)
	if (!match) return packageHref
	return getPackageTreeHref({
		username: match.params.username,
		kodyId: match.params.kodyId,
		ref: input.ref,
		relativePath: input.relativePath,
	})
}

async function resolveOwnerPackageFilesTarget(input: {
	env: Env
	request: Request
	username: string
	kodyId: string
	selectedPath: string
	ref: string | undefined
	pathname: string
}): Promise<CommunityFilesRouteTarget | null> {
	const page = await loadPackagePage({
		env: input.env,
		request: input.request,
		username: input.username,
		kodyId: input.kodyId,
	})
	if (page.kind === 'not_found') return null
	if (page.kind === 'unauthorized') return { kind: 'unauthorized' }
	const requestedRef = requestedTreeRef(input.ref)
	if (page.kind === 'redirect') {
		const ref = isPublicTreeDefaultRefAlias(requestedRef)
			? fallbackDefaultBranchName
			: requestedRef
		return filesPathRedirect(
			treeHrefFromPackageHome(page.to, {
				ref,
				relativePath: input.selectedPath,
			}),
			page.shared,
		)
	}
	const listingSourceId = page.listing?.listing
		? (
				await getCommunityListingById(input.env.APP_DB, {
					listingId: page.listing.listing.id,
					includeDelisted: false,
				})
			)?.sourceId
		: null
	const ref = isPublicTreeDefaultRefAlias(requestedRef)
		? await resolveSourceDefaultTreeRef(
				input.env,
				page.ownerPackage?.sourceId ?? listingSourceId ?? null,
			)
		: requestedRef
	const canonicalPath = getPackageTreeHref({
		username: page.username,
		kodyId: page.kodyId,
		listingId: page.listing?.listing?.id ?? null,
		relativePath: input.selectedPath,
		ref,
	})
	if (canonicalPath !== input.pathname) {
		// Leftover `/files` and default-ref aliases for a listed pair may be
		// cached. Unlisted owner hops must not leak the current tree URL.
		return filesPathRedirect(canonicalPath, Boolean(page.listing?.listing))
	}
	return {
		kind: 'package',
		username: page.username,
		kodyId: page.kodyId,
		selectedPath: input.selectedPath,
		ref,
	}
}

async function canonicalPublicTreeRef(input: {
	env: Env
	listingId: string
	ref: string | undefined
}) {
	if (!isPublicTreeDefaultRefAlias(input.ref)) {
		return requestedTreeRef(input.ref)
	}
	return resolveListingDefaultTreeRef(input.env, input.listingId)
}

export async function resolveCommunityFilesRoute(input: {
	env: Env
	url: URL
	request?: Request
}): Promise<CommunityFilesRouteTarget | null> {
	const detailMatch = communityDetailFilesMatcher.match(input.url)
	if (detailMatch) {
		const selectedPath = selectedPathFromParams(detailMatch.params.relativePath)
		if (selectedPath == null) return { kind: 'invalid-path' }
		const ref = await canonicalPublicTreeRef({
			env: input.env,
			listingId: detailMatch.params.listingId,
			ref: input.url.searchParams.get('ref') ?? '',
		})
		return {
			kind: 'listing',
			listingId: detailMatch.params.listingId,
			selectedPath,
			ref,
		}
	}

	const leftoverFilesMatch = communityPackageFilesMatcher.match(input.url)
	if (leftoverFilesMatch) {
		const selectedPath = selectedPathFromParams(
			leftoverFilesMatch.params.relativePath,
		)
		if (selectedPath == null) return { kind: 'invalid-path' }
		if (isReservedPackageFilesKodyId(leftoverFilesMatch.params.kodyId)) {
			return { kind: 'invalid-path' }
		}
		const target = await resolveCommunityPackageUrl({
			db: input.env.APP_DB,
			username: leftoverFilesMatch.params.username,
			kodyId: leftoverFilesMatch.params.kodyId,
		})
		if (target) {
			const ref = await canonicalPublicTreeRef({
				env: input.env,
				listingId: target.listingId,
				ref: input.url.searchParams.get('ref') ?? '',
			})
			return filesPathRedirect(
				getCommunityPackageFilesHref({
					listingId: target.listingId,
					ownerUsername: target.username,
					kodyId: target.kodyId,
					relativePath: selectedPath,
					ref,
				}),
				true,
			)
		}
		if (!input.request) return null
		return resolveOwnerPackageFilesTarget({
			env: input.env,
			request: input.request,
			username: leftoverFilesMatch.params.username,
			kodyId: leftoverFilesMatch.params.kodyId,
			selectedPath,
			ref: input.url.searchParams.get('ref') ?? '',
			pathname: input.url.pathname,
		})
	}

	const treeMatch = communityPackageTreeMatcher.match(input.url)
	if (!treeMatch) return null

	const selectedPath = selectedPathFromParams(treeMatch.params.relativePath)
	if (selectedPath == null) return { kind: 'invalid-path' }

	const target = await resolveCommunityPackageUrl({
		db: input.env.APP_DB,
		username: treeMatch.params.username,
		kodyId: treeMatch.params.kodyId,
	})
	if (target) {
		const ref = await canonicalPublicTreeRef({
			env: input.env,
			listingId: target.listingId,
			ref: treeMatch.params.ref,
		})
		const canonicalPath = getCommunityPackageFilesHref({
			listingId: target.listingId,
			ownerUsername: target.username,
			kodyId: target.kodyId,
			relativePath: selectedPath,
			ref,
		})
		if (target.kind === 'redirect' || canonicalPath !== input.url.pathname) {
			return filesPathRedirect(canonicalPath, true)
		}
		return {
			kind: 'listing',
			listingId: target.listingId,
			selectedPath,
			ref,
		}
	}

	if (!input.request) return null
	return resolveOwnerPackageFilesTarget({
		env: input.env,
		request: input.request,
		username: treeMatch.params.username,
		kodyId: treeMatch.params.kodyId,
		selectedPath,
		ref: treeMatch.params.ref,
		pathname: input.url.pathname,
	})
}

export async function resolveCanonicalFilesPath(input: {
	env: Env
	listingId: string
	ownerUsername: string
	kodyId: string
	selectedPath: string
	ref?: string
}): Promise<string | null> {
	const target = await resolveCommunityPackageUrl({
		db: input.env.APP_DB,
		username: input.ownerUsername,
		kodyId: input.kodyId,
	})
	if (target?.listingId !== input.listingId) return null
	return getCommunityPackageFilesHref({
		listingId: input.listingId,
		ownerUsername: target.username,
		kodyId: target.kodyId,
		relativePath: input.selectedPath,
		ref: input.ref,
	})
}
