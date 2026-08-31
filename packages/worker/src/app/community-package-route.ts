import { createMatcher } from 'remix/route-pattern/match'
import {
	getCommunityPackageHref,
	resolveCommunityPackageUrl,
} from '#worker/community/package-url.ts'
import {
	fallbackDefaultBranchName,
	getCommunityPackageFilesHref,
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
	| { kind: 'redirect'; to: string }
	| { kind: 'invalid-path' }

function selectedPathFromParams(relativePath: string | undefined) {
	return normalizePackageFilesPath(relativePath ?? '')
}

function requestedTreeRef(ref: string | undefined) {
	return ref?.trim() ?? ''
}

async function resolveListingDefaultTreeRef(env: Env, listingId: string) {
	try {
		const listing = await getCommunityListingById(env.APP_DB, {
			listingId,
			includeDelisted: false,
		})
		if (!listing) return fallbackDefaultBranchName
		const source = await getEntitySourceById(env.APP_DB, listing.sourceId)
		if (!source?.repo_id) return fallbackDefaultBranchName
		const head = await resolveArtifactSourceHead(env, source.repo_id)
		const branch = head.branch?.trim()
		return branch || fallbackDefaultBranchName
	} catch {
		return fallbackDefaultBranchName
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
		if (!target) return null
		const ref = await canonicalPublicTreeRef({
			env: input.env,
			listingId: target.listingId,
			ref: input.url.searchParams.get('ref') ?? '',
		})
		return {
			kind: 'redirect',
			to: getCommunityPackageFilesHref({
				listingId: target.listingId,
				ownerUsername: target.username,
				kodyId: target.kodyId,
				relativePath: selectedPath,
				ref,
			}),
		}
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
	if (!target) return null
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
		return {
			kind: 'redirect',
			to: canonicalPath,
		}
	}
	return {
		kind: 'listing',
		listingId: target.listingId,
		selectedPath,
		ref,
	}
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
