import {
	type RouteLoaderResult,
	routeLoaderRedirect,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	type CommunityDetailApiPayload,
	type CommunityPackageMovedPayload,
} from '#client/routes/community-detail-shared.ts'
import {
	type PackageCollaboratorsLoaderData,
	type PackageCollaboratorsView,
	readPackageCollaboratorsPath,
} from '#universal/package-collaborators.ts'
import { routes } from '#universal/routes.ts'

export type PackageCollaboratorsLoadResult =
	| { kind: 'data'; data: PackageCollaboratorsLoaderData }
	| { kind: 'redirect'; to: string }

const notFound = {
	kind: 'data',
	data: { ok: false, notFound: true },
} as const satisfies PackageCollaboratorsLoadResult

/**
 * The package detail (for the tab chrome) and its collaborators. Anyone who
 * cannot manage access on the package gets not found, like the tab itself.
 */
export async function loadPackageCollaboratorsPage(
	href: string,
	signal: AbortSignal,
): Promise<PackageCollaboratorsLoadResult> {
	const url = new URL(href, 'http://localhost')
	const path = readPackageCollaboratorsPath(url.pathname)
	if (!path) return notFound
	const params = { username: path.username, kodyId: path.kodyId }
	const init = { headers: { Accept: 'application/json' }, signal }
	const [detailResponse, viewResponse] = await Promise.all([
		fetch(routes.communityPackageApi.href(params), init),
		fetch(routes.communityPackageCollaboratorsApi.href(params), {
			...init,
			credentials: 'include',
		}),
	])
	const toLogin = {
		kind: 'redirect',
		to: `/login?redirectTo=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
	} as const
	if (detailResponse.status === 401) return toLogin
	const detail = await readJson<
		CommunityDetailApiPayload | CommunityPackageMovedPayload
	>(detailResponse)
	if (detailResponse.status === 404) {
		const movedTo = detail && !detail.ok ? detail.redirectTo : null
		if (movedTo) return { kind: 'redirect', to: `${movedTo}/collaborators` }
		return notFound
	}
	if (viewResponse.status === 401) return toLogin
	if (viewResponse.status === 403 || viewResponse.status === 404) {
		return notFound
	}
	const view = await readJson<
		PackageCollaboratorsView | { ok: false; error?: string }
	>(viewResponse)
	if (!detailResponse.ok || !detail?.ok) {
		throw new Error('Unable to load this package.')
	}
	if (!viewResponse.ok || !view?.ok) {
		throw new Error(
			(view && !view.ok ? view.error : null) ||
				'Unable to load this package’s collaborators.',
		)
	}
	const ownerPackage = detail.ownerPackage
	if (!ownerPackage) return notFound
	return {
		kind: 'data',
		data: {
			ok: true,
			shell: {
				username: detail.username,
				kodyId: detail.kodyId || ownerPackage.kodyId,
				name: ownerPackage.name,
				description: ownerPackage.description ?? '',
				isPrivate: detail.isPrivate ?? ownerPackage.isPrivate,
				isListed: ownerPackage.hasCommunityListing === true,
				listingId: detail.listing?.id ?? null,
				defaultBranch: detail.listing?.defaultBranch ?? null,
				publishedCommit: ownerPackage.publishedCommit ?? null,
				ownerProfilePublic: detail.ownerProfilePublic,
				viewerCanManage: detail.viewerCanManage,
			},
			view,
		},
	}
}

export async function packageCollaboratorsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const result = await loadPackageCollaboratorsPage(
		`${url.pathname}${url.search}`,
		signal,
	)
	return result.kind === 'redirect'
		? routeLoaderRedirect(result.to)
		: { packageCollaborators: result.data }
}
