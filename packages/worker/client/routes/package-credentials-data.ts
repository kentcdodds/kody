import {
	type RouteLoaderResult,
	routeLoaderRedirect,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	type CommunityDetailApiPayload,
	type CommunityPackageMovedPayload,
} from '#client/routes/community-detail-shared.ts'
import { type PackageCredentialsView } from '#universal/credential-contracts.ts'
import {
	type PackageCredentialsLoaderData,
	readPackageCredentialsTabPath,
} from '#universal/package-credentials-page.ts'
import { routes } from '#universal/routes.ts'

export type PackageCredentialsLoadResult =
	| { kind: 'data'; data: PackageCredentialsLoaderData }
	| { kind: 'redirect'; to: string }

function loginRedirect(href: string) {
	return `/login?redirectTo=${encodeURIComponent(href)}`
}

/**
 * The package detail (for the tab chrome) and the package credentials view,
 * fetched together. A viewer who cannot open the package gets not found. A
 * credentials failure (including no run access) keeps the chrome and reports
 * the error so the tab can offer a prompt for the person's agent.
 */
export async function loadPackageCredentialsPage(
	href: string,
	signal: AbortSignal,
): Promise<PackageCredentialsLoadResult> {
	const url = new URL(href, 'http://localhost')
	const path = readPackageCredentialsTabPath(url.pathname)
	if (!path) return { kind: 'data', data: { ok: false, notFound: true } }
	const params = { username: path.username, kodyId: path.kodyId }
	const init = { headers: { Accept: 'application/json' }, signal }
	const [detailResponse, viewResponse] = await Promise.all([
		fetch(routes.communityPackageApi.href(params), init),
		fetch(routes.communityPackageCredentialsApi.href(params), {
			...init,
			credentials: 'include',
		}).catch((error: unknown) => {
			if (signal.aborted) throw error
			return null
		}),
	])
	const toLogin = {
		kind: 'redirect',
		to: loginRedirect(`${url.pathname}${url.search}`),
	} as const
	if (detailResponse.status === 401) return toLogin
	const detail = await readJson<
		CommunityDetailApiPayload | CommunityPackageMovedPayload
	>(detailResponse)
	// A move or a missing package wins over the credentials API's 401, which
	// it answers for every signed-out caller.
	if (detailResponse.status === 404) {
		const movedTo = detail && !detail.ok ? detail.redirectTo : null
		if (movedTo) return { kind: 'redirect', to: `${movedTo}/${path.tab}` }
		return { kind: 'data', data: { ok: false, notFound: true } }
	}
	if (viewResponse?.status === 401) return toLogin
	if (!detailResponse.ok || !detail?.ok) {
		throw new Error('Unable to load this package.')
	}
	const ownerPackage = detail.ownerPackage
	if (!ownerPackage || !detail.viewerIsOwner) {
		return { kind: 'data', data: { ok: false, notFound: true } }
	}
	const viewPayload = viewResponse
		? await readJson<PackageCredentialsView | { ok: false; error?: string }>(
				viewResponse,
			)
		: null
	const view = viewResponse?.ok && viewPayload?.ok ? viewPayload : null
	const viewError = view ? null : describeViewFailure(viewResponse, viewPayload)
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
			viewError,
		},
	}
}

function describeViewFailure(
	response: Response | null,
	payload: PackageCredentialsView | { ok: false; error?: string } | null,
) {
	if (!response) {
		return 'Kody could not reach the server to load this package’s credentials. Check your connection and reload.'
	}
	if (response.status === 404) {
		return 'You can read this package but not run it, so it has no credentials, mappings, or triggers for you. Ask an org owner for run access.'
	}
	return (
		(payload && !payload.ok ? payload.error : null) ||
		`Kody could not load this package’s credentials (HTTP ${response.status}).`
	)
}

export async function packageCredentialsRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const result = await loadPackageCredentialsPage(
		`${url.pathname}${url.search}`,
		signal,
	)
	return result.kind === 'redirect'
		? routeLoaderRedirect(result.to)
		: { packageCredentials: result.data }
}
