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
import { type AppLoaderData } from '#universal/loader-data.ts'
import {
	type CommunityDetailApiPayload,
	type CommunityInstallApiPayload,
	type CommunityInstallOutcome,
	type CommunityPackageMovedPayload,
	type CommunityShellSnapshot,
	buildCommunityDetailFrameSrc,
	buildReportApiPath,
	getListingPageRef,
	rememberListingId,
} from './community-detail-shared.ts'
import {
	detailArticleCss,
	renderAdminFeatureSection,
	renderEmptyReadme,
	renderInstallStrip,
	renderMissingListing,
	renderReadmeSection,
	renderReportDisclosure,
	renderShellStatus,
} from './community-detail-sections.tsx'

/**
 * Community detail, ported from the redesign prototype
 * (`landing/community-detail.html`). A 46rem article mirroring the blog
 * post: the listing head (back link, `@owner / name`, visibility, Code /
 * Settings tabs, tags, quiet meta row) stays server-rendered in the
 * `community-detail` frame — see `src/app/community-detail-content.tsx` —
 * while this shell renders the README as `.prose`, admin tools, and the
 * report disclosure. Install / Installed / Fork outdated live in the frame
 * next to Featured. Owner controls live on `/settings`.
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
		reportState = 'idle'
		reportMessage = null
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
					viewerIsOwner: payload.viewerIsOwner,
					trusted: payload.listing?.trusted ?? false,
					featured: payload.listing?.featured ?? false,
					readmeContent:
						payload.readmeContent ?? payload.listing?.readmeContent ?? null,
					readmeFences: payload.readmeFences,
					ownerPackage: payload.ownerPackage,
					username: payload.username,
					kodyId:
						payload.kodyId ||
						payload.listing?.kodyId ||
						payload.ownerPackage?.kodyId ||
						'',
					isPrivate:
						payload.isPrivate ?? payload.ownerPackage?.isPrivate ?? false,
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
			official: control.getAttribute('data-official') === 'true',
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
				: 'Loading package details…'

		return (
			<article
				mix={[css(detailArticleCss), on('click', handleCommunityInstallClick)]}
			>
				<Frame name={COMMUNITY_DETAIL_TARGET} src={frameSrc} />

				{renderShellStatus(shellStatusMessage)}

				{showShellReady ? (
					<>
						{listingId
							? renderInstallStrip({
									installState,
									installMessage,
									installOutcome,
									onConfirmInstall: () => void submitInstall(),
									onCancelInstall: () => {
										installState = 'idle'
										handle.update()
									},
								})
							: null}

						{readmeContent
							? renderReadmeSection(renderReadme(readmeContent, readmeFences))
							: renderEmptyReadme()}

						{listingId && viewerIsAdmin
							? renderAdminFeatureSection({
									featured,
									featureState,
									featureMessage,
									onToggleFeature: () => void submitFeature(!featured),
								})
							: null}

						{listingId
							? renderReportDisclosure({
									loggedIn,
									reportReason,
									reportState,
									reportMessage,
									onReasonInput: (value) => {
										reportReason = value
										handle.update()
									},
									onSubmitReport: () => void submitReport(),
								})
							: null}
					</>
				) : null}
			</article>
		)
	}
}
