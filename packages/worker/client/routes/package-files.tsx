// remix-skill: shared /files explorer route (community + account) with a
// Handle-based explorer component and a dedicated lazy area so listing chunks
// do not pull Shiki.
import { type Handle, css } from 'remix/ui'
import { createMatcher } from 'remix/route-pattern/match'
import { PackageFilesExplorer } from '#client/package-files-explorer.tsx'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { createRouteLoadLatch } from '#client/route-load-latch.ts'
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

const communityPackageFilesMatcher = createMatcher(
	routes.communityPackageFiles.pattern,
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

export function PackageFilesRoute(handle: Handle) {
	let status: 'loading' | 'ready' | 'error' | 'not-found' = 'loading'
	let data: PackageFilesLoaderData | null = null
	let loadedHref = ''
	const loadLatch = createRouteLoadLatch()

	async function loadFiles(apiHref: string, href: string, signal: AbortSignal) {
		try {
			const response = await fetch(apiHref, {
				headers: { Accept: 'application/json' },
				credentials: 'include',
				signal,
			})
			if (signal.aborted) return
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			if (response.status === 404) {
				const moved = await readJson<MovedPayload>(response)
				if (moved?.redirectTo) {
					window.location.assign(moved.redirectTo)
					return
				}
				data = null
				status = 'not-found'
				loadedHref = href
				handle.update()
				return
			}
			const payload = await readJson<PackageFilesLoaderData>(response)
			if (signal.aborted) return
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load package files.')
			}
			data = payload
			status = 'ready'
			loadedHref = href
			handle.update()
		} catch {
			if (signal.aborted) return
			status = 'error'
			loadedHref = href
			handle.update()
		}
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const location = readFilesLocation(new URL(currentHref, 'http://localhost'))
		if (!location) {
			return <article />
		}

		const routeData = tryConsumeRouteLoaderData(
			handle,
			'packageFiles',
			currentHref,
		)
		const appliedRouteData = Boolean(routeData?.ok)
		if (routeData?.ok) {
			data = routeData
			status = 'ready'
			loadedHref = currentHref
			loadLatch.markLoaded(currentHref)
		}

		const needsStaleRefresh = consumeStaleNavigationData(currentHref)
		const needsLoad = loadLatch.needsLoad({
			currentHref,
			appliedRouteData,
			needsStaleRefresh,
		})
		if (needsLoad && typeof document !== 'undefined') {
			status = 'loading'
			const loadAttempt = loadLatch.getPendingAttempt()
			handle.queueTask(async (signal) => {
				try {
					await loadFiles(location.apiHref, currentHref, signal)
					if (signal.aborted) {
						loadLatch.clearPending(currentHref, loadAttempt)
						return
					}
					if (status === 'ready' || status === 'not-found') {
						loadLatch.markLoaded(currentHref)
					} else {
						loadLatch.markFailed(currentHref)
					}
				} catch {
					if (signal.aborted) {
						loadLatch.clearPending(currentHref, loadAttempt)
						return
					}
					loadLatch.markFailed(currentHref)
				}
			})
		}

		if (status !== 'ready' || loadedHref !== currentHref || !data) {
			return (
				<article
					mix={css({
						padding: spacing.xl,
						color: colors.textMuted,
					})}
				>
					<p>
						{status === 'not-found'
							? 'Those files were not found.'
							: status === 'error'
								? 'Unable to load package files.'
								: 'Loading files…'}
					</p>
				</article>
			)
		}

		return <PackageFilesExplorer data={data} />
	}
}
