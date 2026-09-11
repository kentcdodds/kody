// remix-skill: shared /files explorer route (community + account) with a
// Handle-based explorer component and a dedicated lazy area so listing chunks
// do not pull Shiki.
import { type Handle, css } from 'remix/ui'
import { NotFoundPage } from '#client/not-found-page.tsx'
import { createMatcher } from 'remix/route-pattern/match'
import { PackageFilesExplorer } from '#client/package-files-explorer.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { createRouteData, routeDataRedirect } from '#client/route-data.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	buildPackageFilesApiHref,
	normalizePackageFilesPath,
} from '#universal/package-files.ts'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

const communityPackageFilesMatcher = createMatcher(
	routes.communityPackageFiles.pattern,
)
const communityPackageTreeMatcher = createMatcher(
	routes.communityPackageTree.pattern,
)
const communityDetailFilesMatcher = createMatcher(
	routes.communityDetailFiles.pattern,
)
const accountPackageFilesMatcher = createMatcher(
	routes.accountPackageFiles.pattern,
)

type FilesLocation =
	| {
			kind: 'community-package'
			apiHref: string
	  }
	| {
			kind: 'community-detail'
			apiHref: string
	  }
	| {
			kind: 'account'
			apiHref: string
	  }

function readFilesLocation(url: URL): FilesLocation | null {
	const communityTree = communityPackageTreeMatcher.match(url)
	if (communityTree) {
		const selectedPath = normalizePackageFilesPath(
			communityTree.params.relativePath ?? '',
		)
		if (selectedPath == null) return null
		const apiHref = buildPackageFilesApiHref(
			routes.communityPackageFilesApi.href({
				username: communityTree.params.username,
				kodyId: communityTree.params.kodyId,
			}),
			selectedPath,
		)
		const separator = apiHref.includes('?') ? '&' : '?'
		return {
			kind: 'community-package',
			apiHref: `${apiHref}${separator}ref=${encodeURIComponent(communityTree.params.ref)}`,
		}
	}

	const communityPackage = communityPackageFilesMatcher.match(url)
	if (communityPackage) {
		const selectedPath = normalizePackageFilesPath(
			communityPackage.params.relativePath ?? '',
		)
		if (selectedPath == null) return null
		return {
			kind: 'community-package',
			apiHref: buildPackageFilesApiHref(
				routes.communityPackageFilesApi.href({
					username: communityPackage.params.username,
					kodyId: communityPackage.params.kodyId,
				}),
				selectedPath,
			),
		}
	}

	const communityDetail = communityDetailFilesMatcher.match(url)
	if (communityDetail) {
		const selectedPath = normalizePackageFilesPath(
			communityDetail.params.relativePath ?? '',
		)
		if (selectedPath == null) return null
		return {
			kind: 'community-detail',
			apiHref: buildPackageFilesApiHref(
				routes.communityDetailFilesApi.href({
					listingId: communityDetail.params.listingId,
				}),
				selectedPath,
			),
		}
	}

	const account = accountPackageFilesMatcher.match(url)
	if (account) {
		const selectedPath = normalizePackageFilesPath(
			account.params.relativePath ?? '',
		)
		if (selectedPath == null) return null
		return {
			kind: 'account',
			apiHref: buildPackageFilesApiHref(
				routes.accountPackageFilesApi.href({
					packageId: account.params.packageId,
				}),
				selectedPath,
			),
		}
	}

	return null
}

type MovedPayload = {
	ok: false
	redirectTo?: string
}

export async function packageFilesRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const location = readFilesLocation(url)
	if (!location) {
		return routeLoaderRedirect(`${url.pathname}${url.search}`)
	}
	const response = await fetch(location.apiHref, {
		headers: { Accept: 'application/json' },
		credentials: 'include',
		signal,
	})
	if (response.status === 401) {
		return routeLoaderRedirect('/login')
	}
	if (response.status === 404) {
		const moved = await readJson<MovedPayload>(response)
		if (moved?.redirectTo) {
			return routeLoaderRedirect(moved.redirectTo)
		}
		throw new Error('Package files not found.')
	}
	const payload = await readJson<PackageFilesLoaderData>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load package files.')
	}
	return { packageFiles: payload }
}

const messageCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `${spacing.xl} ${pageGutter}`,
	color: colors.textMuted,
}

export function PackageFilesRoute(handle: Handle) {
	const filesData = createRouteData({
		key: 'packageFiles',
		async load(href, signal) {
			const location = readFilesLocation(new URL(href, 'http://localhost'))
			if (!location) return null
			const response = await fetch(location.apiHref, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (response.status === 401) return routeDataRedirect('/login')
			if (response.status === 404) {
				const moved = await readJson<MovedPayload>(response)
				if (moved?.redirectTo) return routeDataRedirect(moved.redirectTo)
				return null
			}
			const payload = await readJson<PackageFilesLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load package files.')
			}
			return payload
		},
	})

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const location = readFilesLocation(new URL(currentHref, 'http://localhost'))
		if (!location) {
			return <article />
		}

		const snapshot = filesData.read(handle, currentHref)

		// A miss or a failure replaces the explorer — there is nothing to keep
		// showing, and the visitor has to be told.
		if (snapshot.kind === 'not-found' || snapshot.kind === 'error') {
			return snapshot.kind === 'not-found' ? (
				<NotFoundPage />
			) : (
				<article mix={css(messageCss)}>
					<p>Unable to load package files.</p>
				</article>
			)
		}

		// Only the very first load has nothing to show; a server-rendered visit
		// arrives with data already applied, so this is the SPA cold path.
		const data = snapshot.data
		if (!data) {
			return (
				<article mix={css(messageCss)}>
					<p>Loading files…</p>
				</article>
			)
		}

		// A commit without preloaded data (e.g. the router's loader-failure
		// path) can land here holding another package's explorer; showing it
		// under the new URL would render the wrong tree with the wrong links.
		const currentPathname = new URL(currentHref, 'http://localhost').pathname
		if (
			snapshot.stale &&
			currentPathname !== data.filesBasePath &&
			!currentPathname.startsWith(`${data.filesBasePath}/`)
		) {
			return (
				<article mix={css(messageCss)}>
					<p>Loading files…</p>
				</article>
			)
		}

		// Switching files keeps the current one on screen until the next
		// arrives. Tearing the explorer down to a loading line for the ~6ms
		// between renders blinked the whole tree out and back, and made the
		// page transition run twice per click.
		return (
			<PackageFilesExplorer data={data} busy={snapshot.kind === 'pending'} />
		)
	}
}
