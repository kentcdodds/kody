import { Frame, type Handle, type RemixNode, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { COMMUNITY_DETAIL_TARGET } from '#universal/community-frame-constants.ts'
import {
	listenToRouterNavigation,
	readCurrentRouterHref,
} from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readRouterPathname } from '#client/router-location.tsx'
import { on } from '#client/event-mixin.ts'
import { renderMarkdownNodes } from '#client/markdown-view.tsx'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { decideCommunityInstallClick } from '#client/routes/community-detail-install.ts'
import {
	applyCommunityStarAppearance,
	applyDisplayedCount,
	findCommunityStarCountElement,
	nextDisplayedCount,
	postSocialToggleJson,
	readDisplayedCount,
	readFollowButtonFromEvent,
	submitOptimisticFollow,
} from '#client/community-social-toggle.ts'
import {
	type AccountPackageDetail,
	type AppLoaderData,
} from '#universal/loader-data.ts'
import {
	type CommunityDetailApiPayload,
	type CommunityInstallApiPayload,
	type CommunityInstallOutcome,
	type CommunityPackageMovedPayload,
	type CommunityShellSnapshot,
	buildCommunityDetailFrameSrc,
	buildReportApiPath,
	getListingPageRef,
	postPackageLock,
	rememberListingId,
} from './community-detail-shared.ts'
import {
	detailArticleCss,
	inlineLinkCss,
	missingHeadCss,
	renderAdminFeatureSection,
	renderInstallStrip,
	renderMissingListing,
	renderOwnerPackageSection,
	renderReadmeSection,
	renderReportDisclosure,
	renderShellStatus,
} from './community-detail-sections.tsx'

/**
 * Community detail, ported from the redesign prototype
 * (`landing/community-detail.html`). A 46rem article mirroring the blog
 * post: the listing head (back link, icon + name + author + badges, tags,
 * quiet meta row) stays server-rendered in the `community-detail` frame —
 * see `src/app/community-detail-content.tsx` — while this shell renders the
 * interactive sections around it: the README as `.prose`, admin tools, and
 * the report disclosure. Install / Installed / Fork outdated live in the
 * frame next to Trusted. The title star lives there too.
 */

function getCurrentListingId(handle: Handle) {
	return getListingPageRef(readRouterPathname(handle))?.listingId ?? null
}

export function CommunityDetailRoute(handle: Handle) {
	let loggedIn = false
	let viewerIsAdmin = false
	let featured = false
	let featureState: 'idle' | 'submitting' | 'error' = 'idle'
	let featureMessage: string | null = null
	let installState: 'idle' | 'confirming' | 'submitting' | 'error' = 'idle'
	let installMessage: string | null = null
	let installOutcome: CommunityInstallOutcome | null = null
	let readmeContent: string | null = null
	let readmeFences: Array<HighlightedCode> = []
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
	let starredByViewer = false
	let starMessage: string | null = null
	let starRequestId = 0
	let followRequestId = 0
	let ownerPackage: AccountPackageDetail | null = null
	let username = ''
	let invocationUrlOrigin = ''
	let ownerDetailsMessage: string | null = null
	const lockInFlight = new Map<string, string | null>()
	let shellUnauthorized = false

	// Re-lexing markdown on every handle.update() would be wasted work; cache
	// the rendered README per markdown string (same policy as MarkdownView).
	let renderedForReadme: string | null = null
	let renderedForReadmeFences: Array<HighlightedCode> | undefined
	let renderedReadme: Array<RemixNode> = []

	function renderReadme(markdown: string, fences?: Array<HighlightedCode>) {
		if (renderedForReadme !== markdown || renderedForReadmeFences !== fences) {
			renderedForReadme = markdown
			renderedForReadmeFences = fences
			// Third-party README in the page's prose voice: authored `##`
			// sections land on h3 (DESIGN.md's "h3 subheads"; publishing
			// requires a `## Intent` section), the page keeps its h1, and the
			// untrusted-content link policy (`nofollow ugc`) stays the default.
			renderedReadme = renderMarkdownNodes(markdown, {
				headingOffset: 1,
				fences,
			})
		}
		return renderedReadme
	}

	function applyShellSnapshot(
		snapshot: CommunityShellSnapshot,
		pathname: string,
	) {
		loggedIn = snapshot.loggedIn
		viewerIsAdmin = snapshot.viewerIsAdmin
		featured = snapshot.featured
		featureState = 'idle'
		featureMessage = null
		installState = 'idle'
		installMessage = null
		installOutcome = null
		readmeContent = snapshot.readmeContent
		readmeFences = snapshot.readmeFences ?? []
		starredByViewer = snapshot.starredByViewer
		starMessage = null
		reportState = 'idle'
		reportMessage = null
		ownerPackage = snapshot.ownerPackage
		username = snapshot.username
		invocationUrlOrigin = snapshot.invocationUrlOrigin
		ownerDetailsMessage = null
		shellUnauthorized = false
		shellLoadedForPathname = pathname
		shellStatus = 'ready'
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
			if (response.status === 401) {
				shellLoadedForPathname = ref.pathname
				shellUnauthorized = true
				shellStatus = 'ready'
				handle.update()
				return
			}
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
				throw new Error('Unable to load public package.')
			}
			if (payload.listing) {
				rememberListingId(ref.pathname, payload.listing.id)
			}
			applyShellSnapshot(
				{
					loggedIn: payload.loggedIn,
					viewerIsAdmin: payload.viewerIsAdmin,
					trusted: payload.listing?.trusted ?? false,
					featured: payload.listing?.featured ?? false,
					readmeContent: payload.listing?.readmeContent ?? null,
					readmeFences: payload.readmeFences,
					starredByViewer: payload.starredByViewer,
					ownerPackage: payload.ownerPackage,
					username: payload.username,
					invocationUrlOrigin: payload.invocationUrlOrigin,
				},
				ref.pathname,
			)
			handle.update()
		} catch {
			if (requestId !== shellLoadRequestId) return
			// Mark the listing as attempted so renders do not requeue the load
			// in a loop; the user can recover via navigation or reload.
			shellLoadedForPathname = ref.pathname
			shellStatus = 'error'
			handle.update()
		}
	}

	async function submitStar(button: HTMLElement, nextStarred: boolean) {
		const listingId = getCurrentListingId(handle)
		if (!listingId) return

		const requestId = ++starRequestId
		const previousStarred = button.dataset.starred === 'true'
		const starCountEl = findCommunityStarCountElement(button)
		const previousCount = readDisplayedCount(starCountEl)

		starredByViewer = nextStarred
		starMessage = null
		applyCommunityStarAppearance(button, nextStarred)
		applyDisplayedCount(
			starCountEl,
			nextDisplayedCount(previousCount, previousStarred, nextStarred),
		)
		handle.update()

		const result = await postSocialToggleJson<{
			ok: boolean
			starred?: boolean
			starCount?: number
			error?: string
		}>(
			routes.communityStarApiPost.href({ listingId }),
			{ starred: nextStarred },
			'Unable to update star status.',
		)
		if (requestId !== starRequestId) return

		switch (result.status) {
			case 'unauthorized':
				window.location.assign('/login')
				return
			case 'ok':
				starredByViewer = result.payload.starred ?? nextStarred
				applyCommunityStarAppearance(button, starredByViewer)
				if (result.payload.starCount != null) {
					applyDisplayedCount(starCountEl, result.payload.starCount)
				}
				handle.update()
				return
			case 'error':
				starredByViewer = previousStarred
				applyCommunityStarAppearance(button, previousStarred)
				applyDisplayedCount(starCountEl, previousCount)
				starMessage = result.message
				handle.update()
				return
			default: {
				const exhaustive: never = result
				throw new Error(`Unhandled star result: ${String(exhaustive)}`)
			}
		}
	}

	async function submitFollow(button: HTMLButtonElement) {
		const requestId = ++followRequestId
		const outcome = await submitOptimisticFollow(
			button,
			() => requestId !== followRequestId,
		)
		if (outcome === 'unauthorized') {
			window.location.assign('/login')
		}
	}

	function applyOwnerPackageLock(packageId: string, lockedAt: string | null) {
		if (ownerPackage?.id === packageId) {
			ownerPackage = { ...ownerPackage, lockedAt }
		}
	}

	async function togglePackageLock() {
		if (!ownerPackage || lockInFlight.has(ownerPackage.id)) return
		const packageId = ownerPackage.id
		const previousLockedAt = ownerPackage.lockedAt
		const nextLocked = !(
			typeof previousLockedAt === 'string' && previousLockedAt.trim().length > 0
		)
		const nextLockedAt = nextLocked ? new Date().toISOString() : null
		lockInFlight.set(packageId, nextLockedAt)
		ownerDetailsMessage = null
		applyOwnerPackageLock(packageId, nextLockedAt)
		handle.update()

		const result = await postPackageLock(packageId, nextLocked)
		lockInFlight.delete(packageId)
		if (result.status === 'unauthorized') {
			window.location.assign('/login')
			handle.update()
			return
		}
		if (result.status === 'error') {
			applyOwnerPackageLock(packageId, previousLockedAt)
			if (ownerPackage?.id === packageId) {
				ownerDetailsMessage = result.message
			}
			handle.update()
			return
		}
		applyOwnerPackageLock(packageId, result.lockedAt ?? nextLockedAt)
		if (result.selectedPackage?.id === packageId) {
			ownerPackage = result.selectedPackage
		}
		handle.update()
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
					// The user already confirmed on the listing page.
					body: JSON.stringify({ acknowledged: true }),
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
					payload?.error ?? 'Unable to install this public package.',
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
			const frame = handle.frames.get(COMMUNITY_DETAIL_TARGET)
			if (frame) void frame.reload()
		} catch (error) {
			if (getCurrentListingId(handle) !== listingId) return
			installState = 'error'
			installMessage =
				error instanceof Error
					? error.message
					: 'Unable to install this public package.'
			handle.update()
		}
	}

	function handleCommunityInstallClick(event: Event) {
		const target = event.target
		if (!(target instanceof Element)) return
		const control = target.closest('[data-community-install]')
		if (!control || control instanceof HTMLAnchorElement) return
		event.preventDefault()
		const decision = decideCommunityInstallClick({
			installState,
			alreadyInstalled: installOutcome != null,
		})
		switch (decision) {
			case 'ignore':
				return
			case 'submit':
				void submitInstall()
				return
			case 'confirm':
				installState = 'confirming'
				installMessage = null
				handle.update()
				return
			default: {
				const exhaustive: never = decision
				throw new Error(`Unhandled install click: ${String(exhaustive)}`)
			}
		}
	}

	function handleCommunityStarClick(event: Event) {
		const target = event.target
		if (!(target instanceof Element)) return
		const control = target.closest('[data-community-star]')
		if (
			!(control instanceof HTMLElement) ||
			control instanceof HTMLAnchorElement
		)
			return
		event.preventDefault()
		const nextStarred = control.dataset.starred !== 'true'
		void submitStar(control, nextStarred)
	}

	function handleCommunityFollowActivate(event: Event) {
		const button = readFollowButtonFromEvent(event)
		if (!button) return
		event.preventDefault()
		void submitFollow(button)
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
		if (!routeData) return false
		if (!routeData.ok) {
			shellUnauthorized = true
			shellLoadedForPathname = pathname
			shellStatus = 'ready'
			return true
		}
		if (routeData.listingId && listingId && routeData.listingId !== listingId) {
			return false
		}
		applyShellSnapshot(routeData, pathname)
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
		if (routeData?.ok && routeData.listingId) {
			rememberListingId(pathname, routeData.listingId)
		}
		const ref = getListingPageRef(pathname)
		const listingId = ref?.listingId ?? null

		if (routeData && !routeData.ok) {
			applyRouteShellData(routeData, pathname, listingId)
		}
		if (
			(routeData && !routeData.ok) ||
			(shellUnauthorized && shellLoadedForPathname === pathname)
		) {
			return renderMissingListing(
				'Unauthorized',
				'You are not allowed to view this page.',
			)
		}

		if (!ref) {
			return renderMissingListing(
				'Public package not found',
				'This listing is unavailable.',
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
				: 'Loading public package details…'

		return (
			<article
				mix={[
					css(detailArticleCss),
					on('click', (event) => {
						handleCommunityInstallClick(event)
						handleCommunityStarClick(event)
						handleCommunityFollowActivate(event)
					}),
					on('submit', handleCommunityFollowActivate),
				]}
			>
				<Frame name={COMMUNITY_DETAIL_TARGET} src={frameSrc} />

				{showShellReady && ownerPackage && !listingId ? (
					<header mix={css(missingHeadCss)}>
						<h1>{ownerPackage.name}</h1>
						<p>
							Owner view for{' '}
							<a
								href={routes.profile.href({ username })}
								mix={css(inlineLinkCss)}
							>
								@{username}
							</a>
						</p>
					</header>
				) : null}

				{renderShellStatus(shellStatusMessage)}

				{showShellReady && listingId ? (
					<>
						{renderInstallStrip({
							installState,
							installMessage,
							installOutcome,
							starMessage,
							onConfirmInstall: () => void submitInstall(),
							onCancelInstall: () => {
								installState = 'idle'
								handle.update()
							},
						})}

						{readmeContent
							? renderReadmeSection(renderReadme(readmeContent, readmeFences))
							: null}

						{viewerIsAdmin
							? renderAdminFeatureSection({
									featured,
									featureState,
									featureMessage,
									onToggleFeature: () => void submitFeature(!featured),
								})
							: null}

						{renderReportDisclosure({
							loggedIn,
							reportReason,
							reportState,
							reportMessage,
							onReasonInput: (value) => {
								reportReason = value
								handle.update()
							},
							onSubmitReport: () => void submitReport(),
						})}
					</>
				) : null}

				{showShellReady && ownerPackage
					? renderOwnerPackageSection({
							ownerPackage,
							username,
							invocationUrlOrigin,
							currentHref,
							lockInFlight: lockInFlight.has(ownerPackage.id),
							ownerDetailsMessage,
							onToggleLock: () => void togglePackageLock(),
							onPackagesPayload: (payload) => {
								if (payload.selectedPackage?.id === ownerPackage?.id) {
									ownerPackage = payload.selectedPackage
									handle.update()
								}
							},
						})
					: null}
			</article>
		)
	}
}
