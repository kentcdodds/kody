import { Frame, type Handle, type RemixNode, css } from 'remix/ui'
import { createMatcher } from 'remix/route-pattern/match'
import { routes } from '#universal/routes.ts'
import { COMMUNITY_DETAIL_TARGET } from '#universal/community-frame-constants.ts'
import {
	listenToRouterNavigation,
	readCurrentRouterHref,
} from '#client/client-router.tsx'
import { prefetchFrame } from '#client/frame-prefetch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import { readRouterPathname } from '#client/router-location.tsx'
import { on } from '#client/event-mixin.ts'
import {
	ActionButtonLoader,
	installProgressWords,
} from '#client/action-button-loader.tsx'
import { CopyTextButton } from '#client/copy-text-button.tsx'
import { renderMarkdownNodes } from '#client/markdown-view.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import {
	colors,
	radius,
	transitions,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	getSurfaceCardCss,
	hoverMq,
	mergeCss,
	pageHeadCss,
	proseCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	type PublicCommunityListing,
	type PublicCommunityStargazer,
	type ViewerListingInstall,
} from '#universal/community-public-types.ts'
import {
	type AppLoaderData,
	type CommunityStargazersLoaderData,
} from '#universal/loader-data.ts'
import { formatCommunityPublishedDate } from '#universal/community-display.ts'
import { UserAvatar } from '#universal/user-avatar.tsx'

/**
 * Community detail, ported from the redesign prototype
 * (`landing/community-detail.html`). A 46rem article mirroring the blog
 * post: the listing head (back link, icon + name + author + badges, tags,
 * quiet meta row) stays server-rendered in the `community-detail` frame —
 * see `src/app/community-detail-content.tsx` — while this shell renders the
 * interactive sections around it: one-click install, the fork prompt block,
 * the README as `.prose`, stars, admin tools, and the report disclosure.
 */

type CommunityDetailApiPayload = {
	ok: true
	listing: PublicCommunityListing
	ownerProfilePublic: boolean
	loggedIn: boolean
	viewerIsAdmin: boolean
	forkPrompt: string
	starredByViewer: boolean
	viewerInstall: ViewerListingInstall | null
}

type CommunityPackageMovedPayload = {
	ok: false
	// The canonical pair the requested one was renamed to.
	redirectTo?: string
}

type CommunityInstallApiPayload = {
	ok: boolean
	requiresAcknowledgement?: boolean
	status?: 'installed' | 'adaptation_required'
	packageId?: string
	targetName?: string
	agentPrompt?: string
	failedChecks?: Array<{ kind: string; message: string }>
	error?: string
}

type CommunityInstallOutcome = {
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

function rememberListingId(pathname: string, listingId: string) {
	// Re-setting moves the entry to the end of the insertion order, so the
	// oldest key is always the least recently resolved one.
	listingIdsByPathname.delete(pathname)
	listingIdsByPathname.set(pathname, listingId)
	for (const key of listingIdsByPathname.keys()) {
		if (listingIdsByPathname.size <= maxRememberedListingPathnames) break
		listingIdsByPathname.delete(key)
	}
}

type ListingPageRef = {
	pathname: string
	detailApiHref: string
	listingId: string | null
}

function getListingPageRef(pathname: string): ListingPageRef | null {
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

/**
 * True for both public spellings of a listing page: the canonical
 * `/@owner/kody-id` and the listing-uuid URL that redirects to it.
 */
export function isCommunityListingPathname(pathname: string) {
	return getListingPageRef(pathname) !== null
}

function getCurrentListingId(handle: Handle) {
	return getListingPageRef(readRouterPathname(handle))?.listingId ?? null
}

function buildCommunityDetailFrameSrc(href: string) {
	const url = new URL(href, 'http://localhost')
	if (!getListingPageRef(url.pathname)) return url.pathname
	const followError = url.searchParams.get('followError')
	if (!followError) return url.pathname
	const frameUrl = new URL(url.pathname, 'http://localhost')
	frameUrl.searchParams.set('followError', followError)
	return `${frameUrl.pathname}${frameUrl.search}`
}

export async function communityDetailRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const ref = getListingPageRef(url.pathname)
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
	if (response.status === 404) {
		const movedTo = payload && !payload.ok ? payload.redirectTo : null
		// A renamed package is a real destination, not a dead link: leave the SPA
		// so the visitor lands on (and can copy) the canonical URL.
		if (movedTo) return routeLoaderRedirect(movedTo)
		throw new Error('Community listing not found.')
	}
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load community package.')
	}

	await framePrefetchPromise
	const listingId = payload.listing.id
	rememberListingId(ref.pathname, listingId)

	return {
		communityDetailShell: {
			ok: true,
			listingId,
			name: payload.listing.name,
			description: payload.listing.description,
			forkPrompt: payload.forkPrompt,
			loggedIn: payload.loggedIn,
			viewerIsAdmin: payload.viewerIsAdmin,
			trusted: payload.listing.trusted,
			featured: payload.listing.featured,
			readmeContent: payload.listing.readmeContent,
			starCount: payload.listing.starCount,
			starredByViewer: payload.starredByViewer,
			viewerInstall: payload.viewerInstall,
		},
	}
}

function buildReportApiPath(listingId: string) {
	return routes.communityReportApiPost.href({ listingId })
}

export function CommunityDetailRoute(handle: Handle) {
	let forkPrompt = ''
	let loggedIn = false
	let viewerIsAdmin = false
	let trusted = false
	let trustState: 'idle' | 'submitting' | 'error' = 'idle'
	let trustMessage: string | null = null
	let featured = false
	let featureState: 'idle' | 'submitting' | 'error' = 'idle'
	let featureMessage: string | null = null
	let installState: 'idle' | 'confirming' | 'submitting' | 'error' = 'idle'
	let installMessage: string | null = null
	let installOutcome: CommunityInstallOutcome | null = null
	let existingInstall: ViewerListingInstall | null = null
	let readmeContent: string | null = null
	let shellStatus: 'loading' | 'ready' | 'error' = 'loading'
	let shellLoadRequestId = 0
	let reportReason = ''
	let reportState: 'idle' | 'submitting' | 'success' | 'error' = 'idle'
	let reportMessage: string | null = null
	// Keyed by pathname, not listing id: the canonical URL's listing id is only
	// known after the shell resolves, and the page's identity is its URL either
	// way.
	let shellLoadedForPathname: string | null = null
	let shellRequestedForPathname: string | null = null
	let starCount = 0
	let starredByViewer = false
	let starState: 'idle' | 'submitting' | 'error' = 'idle'
	let starMessage: string | null = null
	let stargazers: Array<PublicCommunityStargazer> = []
	let stargazersTotal = 0
	let stargazersStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
	let stargazersLoadedForListingId: string | null = null

	// Re-lexing markdown on every handle.update() would be wasted work; cache
	// the rendered README per markdown string (same policy as MarkdownView).
	let renderedForReadme: string | null = null
	let renderedReadme: Array<RemixNode> = []

	function renderReadme(markdown: string) {
		if (renderedForReadme !== markdown) {
			renderedForReadme = markdown
			// Third-party README in the page's prose voice: authored `##`
			// sections land on h3 (DESIGN.md's "h3 subheads"; publishing
			// requires a `## Intent` section), the page keeps its h1, and the
			// untrusted-content link policy (`nofollow ugc`) stays the default.
			renderedReadme = renderMarkdownNodes(markdown, { headingOffset: 1 })
		}
		return renderedReadme
	}

	async function loadDetailShell() {
		const ref = getListingPageRef(readRouterPathname(handle))
		if (!ref) return

		const requestId = ++shellLoadRequestId
		// Same-page revalidations keep showing the current shell while the fetch
		// is in flight; only brand-new listings show the loading state.
		if (shellLoadedForPathname !== ref.pathname) {
			shellStatus = 'loading'
			handle.update()
		}

		try {
			const response = await fetch(ref.detailApiHref, {
				headers: { Accept: 'application/json' },
			})
			if (requestId !== shellLoadRequestId) return
			const payload = await readJson<
				CommunityDetailApiPayload | CommunityPackageMovedPayload
			>(response)
			if (response.status === 404) {
				const movedTo = payload && !payload.ok ? payload.redirectTo : null
				// A renamed package is a real destination, not a dead link.
				if (movedTo) {
					window.location.assign(movedTo)
					return
				}
				shellLoadedForPathname = ref.pathname
				shellStatus = 'error'
				handle.update()
				return
			}
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load community package.')
			}
			rememberListingId(ref.pathname, payload.listing.id)
			forkPrompt = payload.forkPrompt
			loggedIn = payload.loggedIn
			viewerIsAdmin = payload.viewerIsAdmin
			trusted = payload.listing.trusted
			trustState = 'idle'
			trustMessage = null
			featured = payload.listing.featured
			featureState = 'idle'
			featureMessage = null
			installState = 'idle'
			installMessage = null
			installOutcome = null
			existingInstall = payload.viewerInstall
			readmeContent = payload.listing.readmeContent
			starCount = payload.listing.starCount
			starredByViewer = payload.starredByViewer
			starState = 'idle'
			starMessage = null
			reportState = 'idle'
			reportMessage = null
			shellLoadedForPathname = ref.pathname
			shellStatus = 'ready'
			handle.update()
			void loadStargazers(payload.listing.id)
		} catch {
			if (requestId !== shellLoadRequestId) return
			// Mark the listing as attempted so renders do not requeue the load
			// in a loop; the user can recover via navigation or reload.
			shellLoadedForPathname = ref.pathname
			shellStatus = 'error'
			handle.update()
		}
	}

	async function loadStargazers(listingId: string) {
		stargazersStatus = 'loading'
		handle.update()
		try {
			const response = await fetch(
				routes.communityStargazersApi.href({ listingId }),
				{ headers: { Accept: 'application/json' } },
			)
			const payload = await readJson<CommunityStargazersLoaderData>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load stargazers.')
			}
			stargazers = payload.stargazers
			stargazersTotal = payload.totalStars
			stargazersLoadedForListingId = listingId
			stargazersStatus = 'ready'
			handle.update()
		} catch {
			stargazersStatus = 'error'
			handle.update()
		}
	}

	async function submitStar(nextStarred: boolean) {
		const listingId = getCurrentListingId(handle)
		if (!listingId || starState === 'submitting') return

		starState = 'submitting'
		starMessage = null
		handle.update()

		try {
			const response = await fetch(
				routes.communityStarApiPost.href({ listingId }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({ starred: nextStarred }),
				},
			)
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{
				ok: boolean
				starred?: boolean
				starCount?: number
				error?: string
			}>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to update star status.')
			}
			starredByViewer = payload.starred ?? nextStarred
			starCount = payload.starCount ?? starCount
			starState = 'idle'
			handle.update()
			void loadStargazers(listingId)
			const frame = handle.frames.get(COMMUNITY_DETAIL_TARGET)
			if (frame) void frame.reload()
		} catch (error) {
			starState = 'error'
			starMessage =
				error instanceof Error ? error.message : 'Unable to update star status.'
			handle.update()
		}
	}

	async function submitReport() {
		const listingId = getCurrentListingId(handle)
		if (!listingId || reportState === 'submitting') return

		reportState = 'submitting'
		reportMessage = null
		handle.update()

		try {
			const response = await fetch(buildReportApiPath(listingId), {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
				},
				credentials: 'include',
				body: JSON.stringify({ reason: reportReason }),
			})
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<{ ok: boolean; error?: string }>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to submit report.')
			}
			reportState = 'success'
			reportMessage = 'Report submitted. Thank you.'
			reportReason = ''
			handle.update()
		} catch (error) {
			reportState = 'error'
			reportMessage =
				error instanceof Error ? error.message : 'Unable to submit report.'
			handle.update()
		}
	}

	async function submitTrust(nextTrusted: boolean) {
		const listingId = getCurrentListingId(handle)
		if (!listingId || trustState === 'submitting') return

		trustState = 'submitting'
		trustMessage = null
		handle.update()

		try {
			const response = await fetch(
				routes.communityTrustApiPost.href({ listingId }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({ trusted: nextTrusted }),
				},
			)
			const payload = await readJson<{
				ok: boolean
				trusted?: boolean
				featured?: boolean
				error?: string
			}>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to update trust.')
			}
			trusted = payload.trusted ?? nextTrusted
			trustState = 'idle'
			// Featuring is only effective while the listing is trusted: revoking
			// trust pulls it from onboarding, and re-trusting a listing whose
			// featured mark survived restores it. Sync from the server response.
			featured = payload.featured ?? (trusted ? featured : false)
			handle.update()
			// The trusted badge renders inside the server frame; reload it so
			// the header reflects the new state immediately.
			const frame = handle.frames.get(COMMUNITY_DETAIL_TARGET)
			if (frame) void frame.reload()
		} catch (error) {
			trustState = 'error'
			trustMessage =
				error instanceof Error ? error.message : 'Unable to update trust.'
			handle.update()
		}
	}

	async function submitFeature(nextFeatured: boolean) {
		const listingId = getCurrentListingId(handle)
		if (!listingId || featureState === 'submitting') return

		featureState = 'submitting'
		featureMessage = null
		handle.update()

		try {
			const response = await fetch(
				routes.communityFeatureApiPost.href({ listingId }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					body: JSON.stringify({ featured: nextFeatured }),
				},
			)
			const payload = await readJson<{
				ok: boolean
				featured?: boolean
				error?: string
			}>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error(payload?.error ?? 'Unable to update featuring.')
			}
			featured = payload.featured ?? nextFeatured
			featureState = 'idle'
			handle.update()
			// The featured badge renders inside the server frame; reload it so
			// the header reflects the new state immediately.
			const frame = handle.frames.get(COMMUNITY_DETAIL_TARGET)
			if (frame) void frame.reload()
		} catch (error) {
			featureState = 'error'
			featureMessage =
				error instanceof Error ? error.message : 'Unable to update featuring.'
			handle.update()
		}
	}

	async function submitInstall() {
		const listingId = getCurrentListingId(handle)
		if (!listingId || installState === 'submitting') return

		installState = 'submitting'
		installMessage = null
		handle.update()

		try {
			const response = await fetch(
				routes.communityInstallApiPost.href({ listingId }),
				{
					method: 'POST',
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json',
					},
					credentials: 'include',
					// Reaching this point means the user either saw the untrusted
					// warning and confirmed, or the listing is trusted.
					body: JSON.stringify({ acknowledged_untrusted: !trusted }),
				},
			)
			if (response.status === 401) {
				window.location.assign('/login')
				return
			}
			const payload = await readJson<CommunityInstallApiPayload>(response)
			// A late response for a previous listing must not overwrite the
			// state of the listing currently on screen.
			if (getCurrentListingId(handle) !== listingId) return
			if (response.status === 409 && payload?.requiresAcknowledgement) {
				// Trust was revoked after this page loaded; surface the warning
				// so the retry carries an explicit acknowledgement.
				trusted = false
				installState = 'confirming'
				installMessage = null
				handle.update()
				return
			}
			if (
				!response.ok ||
				!payload?.ok ||
				!payload.status ||
				!payload.targetName ||
				!payload.agentPrompt
			) {
				throw new Error(
					payload?.error ?? 'Unable to install this community package.',
				)
			}
			installOutcome = {
				status: payload.status,
				targetName: payload.targetName,
				agentPrompt: payload.agentPrompt,
				packageId:
					payload.status === 'installed' ? (payload.packageId ?? null) : null,
				failedChecks: payload.failedChecks ?? [],
			}
			installState = 'idle'
			handle.update()
		} catch (error) {
			if (getCurrentListingId(handle) !== listingId) return
			installState = 'error'
			installMessage =
				error instanceof Error
					? error.message
					: 'Unable to install this community package.'
			handle.update()
		}
	}

	listenToRouterNavigation(handle, () => {
		if (!getListingPageRef(readRouterPathname(handle))) return

		const frame = handle.frames.get(COMMUNITY_DETAIL_TARGET)
		if (!frame) return

		const nextSrc = buildCommunityDetailFrameSrc(readCurrentRouterHref(handle))
		if (frame.src !== nextSrc) {
			frame.src = nextSrc
		}
		void frame.reload()
	})

	function applyRouteShellData(
		routeData: AppLoaderData['communityDetailShell'],
		pathname: string,
		listingId: string | null,
	) {
		if (!routeData || !listingId || routeData.listingId !== listingId) {
			return false
		}
		forkPrompt = routeData.forkPrompt
		loggedIn = routeData.loggedIn
		viewerIsAdmin = routeData.viewerIsAdmin
		trusted = routeData.trusted
		trustState = 'idle'
		trustMessage = null
		featured = routeData.featured
		featureState = 'idle'
		featureMessage = null
		installState = 'idle'
		installMessage = null
		installOutcome = null
		existingInstall = routeData.viewerInstall
		readmeContent = routeData.readmeContent
		starCount = routeData.starCount
		starredByViewer = routeData.starredByViewer
		starState = 'idle'
		starMessage = null
		reportState = 'idle'
		reportMessage = null
		shellLoadedForPathname = pathname
		shellStatus = 'ready'
		if (stargazersLoadedForListingId !== listingId) {
			// This runs during render, and `loadStargazers` calls
			// `handle.update()` before its first await. The runtime only wires
			// up a component's update scheduler after its first render
			// returns, so calling it inline throws instead of scheduling:
			// https://github.com/remix-run/remix/issues/11642
			handle.queueTask(() => void loadStargazers(listingId))
		}
		return true
	}

	return () => {
		const currentHref = readCurrentRouterHref(handle)
		const pathname = readRouterPathname(handle)
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'communityDetailShell',
			currentHref,
		)
		// The canonical URL carries no listing id, so the server's answer for this
		// pathname is what makes the page's listing-scoped actions addressable.
		if (routeData) {
			rememberListingId(pathname, routeData.listingId)
		}
		const ref = getListingPageRef(pathname)
		const listingId = ref?.listingId ?? null

		if (!ref) {
			return (
				<article mix={css(detailArticleCss)}>
					<a href={routes.community.href()} mix={css(backLinkCss)}>
						← Community packages
					</a>
					<header mix={css(missingHeadCss)}>
						<h1>Community package not found</h1>
						<p>This listing is unavailable.</p>
					</header>
				</article>
			)
		}

		const appliedShellData = applyRouteShellData(routeData, pathname, listingId)
		// A same-path refresh whose loader failed leaves no preload and the
		// listing id unchanged; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedShellData
		if (
			(needsStaleRefresh ||
				(shellLoadedForPathname !== pathname &&
					shellRequestedForPathname !== pathname)) &&
			typeof document !== 'undefined'
		) {
			// Show the loading state immediately so the previous listing's
			// shell (fork prompt, README, login state) never renders under the
			// new listing's header while the refetch is in flight. Same-listing
			// stale refreshes keep the current shell visible instead. Tracking
			// the requested listing separately keeps re-renders from enqueueing
			// duplicate fetches while one is already in flight.
			if (shellLoadedForPathname !== pathname) {
				shellStatus = 'loading'
			}
			shellRequestedForPathname = pathname
			handle.queueTask(loadDetailShell)
		}

		const frameSrc = buildCommunityDetailFrameSrc(currentHref)

		// Never show another listing's shell data: even if an in-flight fetch
		// for the previous listing resolves late, mismatched pages render the
		// loading state until the current listing's shell arrives.
		const shellMatchesListing = shellLoadedForPathname === pathname
		const showShellReady = shellStatus === 'ready' && shellMatchesListing
		const showShellError = shellStatus === 'error' && shellMatchesListing
		const shellStatusMessage = showShellError
			? 'Unable to load fork and report details for this listing.'
			: showShellReady
				? ''
				: 'Loading community package details…'
		const shownInstall = installOutcome
			? { ...installOutcome, existing: false }
			: existingInstall
				? {
						status: existingInstall.status,
						targetName: existingInstall.targetName,
						agentPrompt: existingInstall.agentPrompt,
						packageId: existingInstall.packageId,
						failedChecks: [] as Array<{ kind: string; message: string }>,
						existing: true,
					}
				: null

		return (
			<article mix={css(detailArticleCss)}>
				<Frame name={COMMUNITY_DETAIL_TARGET} src={frameSrc} />

				{/*
				 * A live region only announces text that changes while the region
				 * is already in the accessibility tree, so the announcer stays
				 * mounted for the life of the view and keeps one fixed role.
				 * Swapping two `role="status"` paragraphs announced the failure
				 * inconsistently, because the loading one unmounted as the error
				 * one mounted. Same shape as `renderStatusMessage` in login.tsx.
				 */}
				<p role="status" mix={css(visuallyHiddenCss)}>
					{shellStatusMessage}
				</p>
				{/*
				 * The visible copy is hidden from assistive tech so the same
				 * sentence is not announced twice, and stays out of the flow while
				 * empty so it adds no gap.
				 */}
				<p
					aria-hidden="true"
					hidden={shellStatusMessage ? undefined : true}
					mix={css(shellStatusCss)}
				>
					{shellStatusMessage}
				</p>

				{showShellReady ? (
					<>
						<section
							aria-labelledby="install-title"
							mix={css(detailSectionCss)}
							data-testid="community-install"
						>
							<h2 id="install-title">One-click install</h2>
							{shownInstall ? (
								shownInstall.status === 'installed' ? (
									<>
										<p data-testid="community-install-success" role="status">
											{shownInstall.existing
												? 'Already installed as'
												: 'Installed as'}{' '}
											{shownInstall.targetName}.
											{shownInstall.existing
												? ''
												: ' Any jobs or auto-start services the package declares are now active.'}
										</p>
										<p>
											<a
												href={
													shownInstall.packageId
														? routes.accountPackageDetail.href({
																packageId: shownInstall.packageId,
															})
														: routes.accountPackages.href()
												}
												mix={css(inlineLinkCss)}
												data-testid="community-install-open-package"
											>
												{shownInstall.packageId
													? 'Open in your packages'
													: 'View it in your packages'}
											</a>
										</p>
										<p>
											Give this prompt to your agent to finish any remaining
											setup (secrets, connections, a first test run):
										</p>
										<div mix={css(promptGroupCss)}>
											<blockquote mix={css(promptBlockCss)}>
												{shownInstall.agentPrompt}
											</blockquote>
											<CopyTextButton
												value={shownInstall.agentPrompt}
												idleLabel="Copy prompt"
												variant="pill"
											/>
										</div>
									</>
								) : (
									<>
										<p data-testid="community-install-adaptation" role="status">
											{shownInstall.existing
												? 'Already forked as'
												: 'Forked as'}{' '}
											{shownInstall.targetName}, but it needs adaptation before
											it can run in your account.
										</p>
										{shownInstall.failedChecks.length > 0 ? (
											<ul mix={css(checkListCss)}>
												{shownInstall.failedChecks.map((check) => (
													<li key={check.kind}>
														{check.kind}: {check.message}
													</li>
												))}
											</ul>
										) : null}
										<p>
											Give this prompt to your agent to adapt and publish it:
										</p>
										<div mix={css(promptGroupCss)}>
											<blockquote mix={css(promptBlockCss)}>
												{shownInstall.agentPrompt}
											</blockquote>
											<CopyTextButton
												value={shownInstall.agentPrompt}
												idleLabel="Copy prompt"
												variant="pill"
											/>
										</div>
									</>
								)
							) : (
								<>
									<p>
										Install forks this package into your account and publishes
										it right away when it passes the standard package checks.
										{trusted
											? ' An admin reviewed and trusted this exact version.'
											: ' This listing has not been reviewed by an admin.'}
									</p>
									{loggedIn ? (
										installState === 'confirming' ? (
											<div
												mix={css(warningCardCss)}
												data-testid="community-install-warning"
												role="alert"
											>
												<p mix={css({ margin: 0 })}>
													This package is not trusted: no admin has reviewed its
													code, and it was written by another user. Installing
													publishes it into your account and can activate its
													scheduled jobs and services immediately. Only continue
													if you accept that risk.
												</p>
												<div mix={css(buttonRowCss)}>
													<button
														mix={[
															on('click', () => void submitInstall()),
															css(dangerPillButtonCss),
														]}
													>
														Install anyway
													</button>
													<button
														mix={[
															on('click', () => {
																installState = 'idle'
																handle.update()
															}),
															css(smallGhostButtonCss),
														]}
													>
														Cancel
													</button>
												</div>
											</div>
										) : (
											<div mix={css(sectionActionCss)}>
												<button
													disabled={installState === 'submitting'}
													aria-busy={
														installState === 'submitting' ? 'true' : undefined
													}
													mix={[
														on('click', () => {
															if (trusted) {
																void submitInstall()
																return
															}
															installState = 'confirming'
															installMessage = null
															handle.update()
														}),
														css(pillButtonCss),
													]}
												>
													{installState === 'submitting' ? (
														<ActionButtonLoader
															label="Installing"
															words={installProgressWords}
														/>
													) : (
														'Install'
													)}
												</button>
											</div>
										)
									) : (
										<p>
											<a href="/login" mix={css(inlineLinkCss)}>
												Log in
											</a>{' '}
											to install this package.
										</p>
									)}
									{installMessage ? (
										<p mix={css(errorTextCss)} role="alert">
											{installMessage}
										</p>
									) : null}
								</>
							)}
						</section>

						<section aria-labelledby="fork-title" mix={css(detailSectionCss)}>
							<h2 id="fork-title">Fork with your agent</h2>
							<p>
								Copy this prompt into your MCP-capable agent to fork and adapt
								the package safely. Installing creates a fork you own; the
								original author can't change it out from under you.
							</p>
							<div mix={css(promptGroupCss)}>
								<blockquote id="fork-prompt" mix={css(promptBlockCss)}>
									{forkPrompt}
								</blockquote>
								<CopyTextButton
									value={forkPrompt}
									idleLabel="Copy prompt"
									variant="pill"
								/>
							</div>
						</section>

						{readmeContent ? (
							<section
								aria-labelledby="readme-title"
								mix={css(readmeSectionCss)}
							>
								<h2 id="readme-title">README</h2>
								<div data-testid="community-readme" mix={css(readmeProseCss)}>
									{renderReadme(readmeContent)}
								</div>
							</section>
						) : null}

						<section
							aria-labelledby="stars-title"
							mix={css(detailSectionCss)}
							data-testid="community-star"
						>
							<h2 id="stars-title">Stars</h2>
							<p data-testid="community-star-count">
								{starCount} {starCount === 1 ? 'star' : 'stars'}
							</p>
							{loggedIn ? (
								<div mix={css(sectionActionCss)}>
									<button
										type="button"
										disabled={starState === 'submitting'}
										mix={[
											on('click', () => void submitStar(!starredByViewer)),
											css(
												starredByViewer ? smallGhostButtonCss : pillButtonCss,
											),
										]}
									>
										{starState === 'submitting'
											? 'Saving…'
											: starredByViewer
												? 'Unstar'
												: 'Star'}
									</button>
								</div>
							) : (
								<p>
									<a href="/login" mix={css(inlineLinkCss)}>
										Log in
									</a>{' '}
									to star this package.
								</p>
							)}
							{starMessage ? (
								<p mix={css(errorTextCss)} role="alert">
									{starMessage}
								</p>
							) : null}
							{/*
							 * Only once the fetch resolved. `stargazersTotal` starts
							 * at 0, so rendering it unconditionally put a second,
							 * contradictory number next to the shell's own
							 * `starCount` ("5 stars" above "0 stargazers") for the
							 * length of the request — and left it there for good if
							 * the request failed.
							 */}
							{stargazersStatus === 'ready' ? (
								<p data-testid="community-stargazers-total">
									{stargazersTotal}{' '}
									{stargazersTotal === 1 ? 'stargazer' : 'stargazers'}
								</p>
							) : null}
							{stargazersStatus === 'loading' ? (
								<p>Loading stargazers…</p>
							) : null}
							{stargazersStatus === 'error' ? (
								<p>Unable to load the stargazer list.</p>
							) : null}
							{stargazersStatus === 'ready' && stargazers.length > 0 ? (
								<ul
									mix={css(stargazerListCss)}
									data-testid="community-stargazers"
								>
									{stargazers.map((stargazer) => (
										<li key={stargazer.username}>
											<UserAvatar
												displayName={stargazer.displayName}
												avatarUrl={stargazer.avatarUrl}
												size={32}
											/>
											<span>
												<a
													href={routes.profile.href({
														username: stargazer.username,
													})}
													mix={css(stargazerLinkCss)}
												>
													{stargazer.displayName}
												</a>{' '}
												<span mix={css({ color: colors.textMuted })}>
													starred{' '}
													{formatCommunityPublishedDate(stargazer.starredAt)}
												</span>
											</span>
										</li>
									))}
								</ul>
							) : null}
						</section>

						{viewerIsAdmin ? (
							<section
								aria-labelledby="admin-trust-title"
								mix={css(detailSectionCss)}
								data-testid="community-admin-trust"
							>
								<h2 id="admin-trust-title">Admin: trust</h2>
								<p>
									{trusted
										? 'This listing is marked trusted at its current version. Revoking removes the badge immediately.'
										: 'Marking this listing trusted applies to the exact current version only. A republish by the owner drops the mark until it is re-reviewed.'}
								</p>
								<div mix={css(sectionActionCss)}>
									<button
										disabled={trustState === 'submitting'}
										mix={[
											on('click', () => void submitTrust(!trusted)),
											css(smallGhostButtonCss),
										]}
									>
										{trustState === 'submitting'
											? 'Saving…'
											: trusted
												? 'Revoke trust'
												: 'Mark as trusted'}
									</button>
								</div>
								{trustMessage ? (
									<p mix={css(errorTextCss)} role="alert">
										{trustMessage}
									</p>
								) : null}
							</section>
						) : null}

						{viewerIsAdmin ? (
							<section
								aria-labelledby="admin-feature-title"
								mix={css(detailSectionCss)}
								data-testid="community-admin-feature"
							>
								<h2 id="admin-feature-title">Admin: onboarding</h2>
								<p>
									{featured
										? 'This listing is featured as an onboarding starter package. Removing it hides it from onboarding immediately.'
										: trusted
											? 'Featuring offers this listing for one-click install during onboarding. A republish by the owner drops it from onboarding until the new version is re-trusted.'
											: 'Only trusted listings can be featured in onboarding. Mark the listing trusted first.'}
								</p>
								<div mix={css(sectionActionCss)}>
									<button
										disabled={
											featureState === 'submitting' || (!featured && !trusted)
										}
										mix={[
											on('click', () => void submitFeature(!featured)),
											css(smallGhostButtonCss),
										]}
									>
										{featureState === 'submitting'
											? 'Saving…'
											: featured
												? 'Remove from onboarding'
												: 'Feature in onboarding'}
									</button>
								</div>
								{featureMessage ? (
									<p mix={css(errorTextCss)} role="alert">
										{featureMessage}
									</p>
								) : null}
							</section>
						) : null}

						<details id="report" mix={css(reportDisclosureCss)}>
							<summary>Report this listing</summary>
							{loggedIn ? (
								<div mix={css(reportFormCss)}>
									<label mix={css(reportFieldCss)}>
										<span>Reason</span>
										<textarea
											value={reportReason}
											rows={4}
											maxLength={2000}
											placeholder="Describe why this listing should be reviewed."
											mix={[
												css(reportTextareaCss),
												on('input', (event) => {
													reportReason = (event.target as HTMLTextAreaElement)
														.value
													handle.update()
												}),
											]}
										/>
									</label>
									<button
										disabled={
											reportState === 'submitting' || !reportReason.trim()
										}
										mix={[
											on('click', () => void submitReport()),
											css(smallGhostButtonCss),
										]}
									>
										{reportState === 'submitting'
											? 'Submitting…'
											: 'Submit report'}
									</button>
									{reportMessage ? (
										<p
											mix={css(
												reportState === 'error' ? errorTextCss : mutedTextCss,
											)}
											role={reportState === 'error' ? 'alert' : 'status'}
										>
											{reportMessage}
										</p>
									) : null}
								</div>
							) : (
								<p mix={css(reportLoginNoteCss)}>
									<a href="/login" mix={css(inlineLinkCss)}>
										Log in
									</a>{' '}
									to report this listing.
								</p>
							)}
						</details>
					</>
				) : null}
			</article>
		)
	}
}

/* ---------- styles (prototype: `.pkg-detail` in landing/styles.css) ---------- */

/* 46rem article measure mirroring the blog post; the route owns its gutters
   (the app shell leaves redesigned marketing paths unpadded). The shirt-
   pattern whisper anchors to the article in rem, not to the short icon-row
   head in percentages, so it renders at the same scale and position as the
   blog post head's fabric. */
const detailArticleCss = {
	position: 'relative' as const,
	// This borrows `pageHeadCss`'s `zIndex: -1` pseudo without borrowing the
	// rest of it, so it has to carry the `isolate` that scopes that negative
	// z-index. Without it the glow escapes this stacking context and can fall
	// behind an ancestor's background instead of backing the article.
	isolation: 'isolate' as const,
	maxWidth: '46rem',
	marginInline: 'auto',
	width: '100%',
	boxSizing: 'border-box' as const,
	padding:
		'clamp(2.5rem, 6vw, 4rem) clamp(1.25rem, 4vw, 2.5rem) clamp(4rem, 8vw, 6.5rem)',
	'&::before': {
		...pageHeadCss['&::before'],
		inset: 'auto',
		top: '-3rem',
		left: '-30%',
		right: '-30%',
		height: '44rem',
		background: `radial-gradient(ellipse 46% 55% at 70% 22%, oklch(from ${colors.text} l c h / 0.05), transparent 72%)`,
	},
}

const backLinkCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.4rem',
	fontSize: '0.95rem',
	fontWeight: 550,
	color: colors.primaryText,
	textDecoration: 'none',
	'&:hover': {
		color: colors.text,
	},
}

const missingHeadCss = {
	marginTop: '1.8rem',
	'& h1': {
		margin: 0,
		fontSize: 'clamp(1.7rem, 4vw, 2.4rem)',
		fontWeight: 760,
		letterSpacing: '-0.024em',
		lineHeight: 1.05,
	},
	'& p': {
		margin: '0.9rem 0 0',
		color: colors.textMuted,
	},
}

const shellStatusCss = {
	margin: 'clamp(1.8rem, 4vw, 2.5rem) 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}

/* Quiet sections in the `.pkg-fork` voice: display-face h2, muted lede. */
const detailSectionCss = {
	marginTop: 'clamp(2.4rem, 5vw, 3.2rem)',
	'& h2': {
		margin: 0,
		fontSize: 'clamp(1.4rem, 2.4vw, 1.65rem)',
		fontWeight: 720,
		letterSpacing: '-0.016em',
	},
	'& > p': {
		margin: '0.6rem 0 0',
		color: colors.textMuted,
		fontSize: '0.98rem',
		maxWidth: '56ch',
		textWrap: 'balance' as const,
	},
	// Error lines must out-rank the muted `& > p` default above.
	'& > p[role="alert"]': {
		color: colors.error,
	},
}

const sectionActionCss = {
	marginTop: '1.1rem',
}

const promptGroupCss = {
	marginTop: '1.2rem',
	'& > button': {
		marginTop: '0.8rem',
	},
}

const promptBlockCss = {
	margin: 0,
	fontSize: '0.98rem',
	lineHeight: 1.6,
	color: colors.text,
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	padding: '1.1rem 1.3rem',
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'break-word' as const,
}

const pillButtonCss = getPillButtonCss()

/* The prototype's smaller `.account-form .button` sizing. */
const smallGhostButtonCss = mergeCss(getGhostButtonCss(), {
	fontSize: '0.95rem',
	padding: '0.75rem 1.3rem',
})

/* The pill grammar in the danger voice for the untrusted-install confirm. */
const dangerPillButtonCss = mergeCss(getPillButtonCss(), {
	backgroundColor: colors.danger,
	color: colors.onDanger,
	[hoverMq]: {
		'&:not(:disabled):hover': {
			backgroundColor: colors.dangerHover,
			color: colors.onDanger,
			boxShadow: `0 6px 20px -8px oklch(from ${colors.danger} l c h / 0.6)`,
		},
	},
})

const warningCardCss = mergeCss(getSurfaceCardCss(), {
	marginTop: '1.2rem',
	borderColor: colors.danger,
	padding: '1.1rem 1.3rem',
	display: 'grid',
	gap: '0.9rem',
	'& p': {
		fontSize: '0.95rem',
	},
})

const buttonRowCss = {
	display: 'flex',
	gap: '0.5rem',
	flexWrap: 'wrap' as const,
}

const checkListCss = {
	margin: '0.8rem 0 0',
	paddingLeft: '1.25rem',
	color: colors.textMuted,
	fontSize: '0.92rem',
	display: 'grid',
	gap: '0.35rem',
}

const inlineLinkCss = {
	color: colors.primaryText,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
}

const errorTextCss = {
	margin: '0.8rem 0 0',
	color: colors.error,
	fontSize: '0.95rem',
}

const mutedTextCss = {
	margin: '0.8rem 0 0',
	color: colors.textMuted,
	fontSize: '0.95rem',
}

/* README as real prose (no scroll box), h3 subheads per DESIGN.md. */
const readmeSectionCss = {
	marginTop: 'clamp(2.4rem, 5vw, 3.2rem)',
	'& > h2': {
		margin: 0,
		fontSize: 'clamp(1.4rem, 2.4vw, 1.65rem)',
		fontWeight: 720,
		letterSpacing: '-0.016em',
		paddingBottom: '0.9rem',
		borderBottom: `1px solid ${colors.border}`,
	},
}

const readmeProseCss = mergeCss(proseCss, {
	marginTop: '1.4rem',
	'& h3': {
		margin: '1.8rem 0 0',
		fontSize: '1.15rem',
		fontWeight: 720,
		letterSpacing: '-0.01em',
	},
})

const stargazerListCss = {
	listStyle: 'none',
	margin: '1.1rem 0 0',
	padding: 0,
	display: 'grid',
	gap: '0.45rem',
	fontSize: '0.92rem',
	'& > li': {
		display: 'flex',
		alignItems: 'center',
		gap: '0.5rem',
	},
}

const stargazerLinkCss = {
	color: colors.text,
	fontWeight: 550,
	textDecoration: 'none',
	transition: `color ${transitions.fast}`,
	'&:hover': {
		color: colors.primaryText,
	},
}

/* "Report this listing" tucked in a details disclosure. */
const reportDisclosureCss = {
	marginTop: 'clamp(2.4rem, 5vw, 3.2rem)',
	'& summary': {
		cursor: 'pointer',
		fontWeight: 600,
		color: colors.textMuted,
		width: 'fit-content',
		transition: `color ${transitions.fast}`,
	},
	'& summary:hover': {
		color: colors.text,
	},
	'&[open] summary': {
		color: colors.text,
	},
	'& > :not(summary)': {
		'@media (prefers-reduced-motion: no-preference)': {
			transition: `opacity 200ms ${transitions.easeOut}, translate 200ms ${transitions.easeOut}`,
		},
		'@starting-style': {
			opacity: 0,
			translate: '0 4px',
		},
	},
}

const reportFormCss = {
	marginTop: '1.3rem',
	maxWidth: '34rem',
	display: 'grid',
	gap: '1rem',
	justifyItems: 'start',
}

const reportFieldCss = {
	width: '100%',
	display: 'grid',
	gap: '0.45rem',
	'& > span': {
		fontSize: '0.92rem',
		fontWeight: 600,
		color: colors.text,
	},
}

const reportTextareaCss = {
	font: `400 1rem/1.5 ${typography.fontFamilyBody}`,
	color: colors.text,
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: '12px',
	padding: '0.85rem 1.05rem',
	width: '100%',
	minHeight: '6.5rem',
	resize: 'vertical' as const,
	boxSizing: 'border-box' as const,
	'&::placeholder': {
		color: colors.textMuted,
		opacity: 1,
	},
	'&:focus': {
		outline: 'none',
		borderColor: colors.primary,
		boxShadow: `0 0 0 3px oklch(from ${colors.primary} l c h / 0.25)`,
	},
}

const reportLoginNoteCss = {
	margin: '1.3rem 0 0',
	color: colors.textMuted,
	fontSize: '0.98rem',
}
