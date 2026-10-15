import { Frame, type Handle, type RemixNode, css } from 'remix/component'
import { routes } from '#universal/routes.ts'
import { getPackageTreeHref } from '#universal/package-files.ts'
import { COMMUNITY_DETAIL_TARGET } from '#universal/community-frame-constants.ts'
import {
	listenToRouterNavigation,
	readCurrentRouterHref,
} from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { readRouterPathname } from '#client/router-location.tsx'
import { renderMarkdownNodes } from '#client/markdown-view.tsx'
import { NotFoundPage } from '#client/not-found-page.tsx'
import { PackageNoAccessPage } from '#client/package-no-access-page.tsx'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { createCommunityInstallController } from '#client/routes/community-install-controller.ts'
import { createPackageFollowController } from '#client/routes/package-follow-controller.tsx'
import { type AppLoaderData } from '#universal/loader-data.ts'
import {
	type CommunityDetailApiPayload,
	type CommunityPackageMovedPayload,
	type CommunityPackageNoAccessPayload,
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
	renderMissingListing,
	renderReadmeSection,
	renderReportDisclosure,
	renderShellStatus,
} from './community-detail-sections.tsx'

/**
 * Community detail, ported from the redesign prototype
 * (`landing/community-detail.html`). A 46rem article mirroring the blog
 * post: the listing head (back link, `@owner / name`, visibility, Repo /
 * Files / Settings tabs, tags, quiet meta row) stays server-rendered in the
 * `community-detail` frame — see `src/app/community-detail-content.tsx` —
 * while this shell renders the README as `.prose`, admin tools, and the
 * report disclosure. Fork, open fork, outdated, and copy-setup live in the
 * frame's repository action group; `createCommunityInstallController` owns
 * the confirm-then-POST flow (shared with the Files tab). Owner controls
 * live on `/settings`.
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
	const install = createCommunityInstallController(handle, {
		getActiveListingId: () => getCurrentListingId(handle),
		onInstalled: () => {
			const frame = handle.frames.get(COMMUNITY_DETAIL_TARGET)
			if (frame) void frame.reload()
		},
	})
	let readmeContent: string | null = null
	let readmeFences: Array<HighlightedCode> = []
	let hasAgentsDocs = false
	let readmeImageBaseHref: string | null = null
	let username = ''
	let kodyId = ''
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
	let shellNotFound = false
	let shellNoAccess: {
		username: string
		kodyId: string
		packageName: string
		viewerUsername: string
	} | null = null

	const follow = createPackageFollowController(handle, {
		getPackageRef: () => {
			const pathname = readRouterPathname(handle)
			if (shellLoadedForPathname !== pathname || !username || !kodyId) {
				return null
			}
			return { pathname, username, kodyId }
		},
		onChanged: async () => {
			const frame = handle.frames.get(COMMUNITY_DETAIL_TARGET)
			if (frame) await frame.reload()
		},
	})

	// Re-lexing markdown on every handle.update() would be wasted work; cache
	// the rendered README per markdown string (same policy as MarkdownView).
	let renderedForReadme: string | null = null
	let renderedForReadmeFences: Array<HighlightedCode> | undefined
	let renderedForReadmeImageBase: string | null = null
	let renderedReadme: Array<RemixNode> = []

	function renderReadme(
		markdown: string,
		fences: Array<HighlightedCode> | undefined,
		imageBaseHref: string | null,
	) {
		if (
			renderedForReadme !== markdown ||
			renderedForReadmeFences !== fences ||
			renderedForReadmeImageBase !== imageBaseHref
		) {
			renderedForReadme = markdown
			renderedForReadmeFences = fences
			renderedForReadmeImageBase = imageBaseHref
			// Third-party README in the page's prose voice: authored `##`
			// sections land on h3 (DESIGN.md's "h3 subheads"; publishing
			// requires a `## Intent` section), the page keeps its h1, and the
			// untrusted-content link policy (`nofollow ugc`) stays the default.
			renderedReadme = renderMarkdownNodes(markdown, {
				headingOffset: 1,
				fences,
				imageBaseHref: imageBaseHref ?? undefined,
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
		install.applySnapshot(getListingPageRef(pathname)?.listingId ?? null)
		readmeContent = snapshot.readmeContent
		readmeFences = snapshot.readmeFences ?? []
		hasAgentsDocs = snapshot.hasAgentsDocs
		readmeImageBaseHref = snapshot.imageBaseHref
		username = snapshot.username
		kodyId = snapshot.kodyId
		reportState = 'idle'
		reportMessage = null
		shellUnauthorized = false
		shellNotFound = false
		shellNoAccess = null
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
				| CommunityDetailApiPayload
				| CommunityPackageMovedPayload
				| CommunityPackageNoAccessPayload
			>(response)
			if (response.status === 401) {
				shellLoadedForPathname = ref.pathname
				shellUnauthorized = true
				shellNotFound = false
				shellNoAccess = null
				shellStatus = 'ready'
				handle.update()
				return
			}
			if (
				response.status === 403 &&
				payload &&
				!payload.ok &&
				'noAccess' in payload &&
				payload.noAccess
			) {
				shellLoadedForPathname = ref.pathname
				shellNoAccess = {
					username: payload.username,
					kodyId: payload.kodyId,
					packageName: payload.packageName,
					viewerUsername: payload.viewerUsername,
				}
				shellUnauthorized = false
				shellNotFound = false
				shellStatus = 'ready'
				handle.update()
				return
			}
			if (response.status === 404) {
				const movedTo =
					payload && !payload.ok && 'redirectTo' in payload
						? payload.redirectTo
						: null
				// A renamed package is a real destination, not a dead link.
				if (movedTo) {
					window.location.assign(movedTo)
					return
				}
				shellLoadedForPathname = ref.pathname
				shellNotFound = true
				shellUnauthorized = false
				shellNoAccess = null
				shellStatus = 'ready'
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
					hasAgentsDocs: payload.hasAgentsDocs === true,
					imageBaseHref: payload.imageBaseHref ?? null,
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

	listenToRouterNavigation(handle, () => {
		const ref = getListingPageRef(readRouterPathname(handle))
		// Navigation reloads the frame, so the rebuilt Fork is idle.
		install.navigated(ref?.listingId ?? null)
		follow.navigated(ref?.pathname ?? null)
		if (!ref) return

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
			if ('unauthorized' in routeData) {
				shellUnauthorized = true
				shellNotFound = false
				shellNoAccess = null
			} else if ('notFound' in routeData) {
				shellNotFound = true
				shellUnauthorized = false
				shellNoAccess = null
			} else if ('noAccess' in routeData) {
				shellNoAccess = {
					username: routeData.username,
					kodyId: routeData.kodyId,
					packageName: routeData.packageName,
					viewerUsername: routeData.viewerUsername,
				}
				shellUnauthorized = false
				shellNotFound = false
			} else {
				const exhaustive: never = routeData
				throw new Error(`Unhandled community shell: ${String(exhaustive)}`)
			}
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
		// A later successful load for this pathname must win over a stale
		// shellNoAccess left from an earlier 403 (access grant mid-session).
		const noAccessProps = routeData?.ok
			? null
			: routeData && !routeData.ok && 'noAccess' in routeData
				? {
						username: routeData.username,
						kodyId: routeData.kodyId,
						packageName: routeData.packageName,
						viewerUsername: routeData.viewerUsername,
					}
				: shellNoAccess && shellLoadedForPathname === pathname
					? shellNoAccess
					: null
		if (noAccessProps) {
			return <PackageNoAccessPage {...noAccessProps} />
		}
		if (
			(routeData && !routeData.ok && 'unauthorized' in routeData) ||
			(shellUnauthorized && shellLoadedForPathname === pathname)
		) {
			return renderMissingListing(
				'Unauthorized',
				'You are not allowed to view this page.',
			)
		}

		if (
			(routeData && !routeData.ok && 'notFound' in routeData) ||
			(shellNotFound && shellLoadedForPathname === pathname) ||
			!ref
		) {
			return <NotFoundPage />
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
		follow.maybeAutoOpen(pathname)

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
		const agentsDocsHref =
			hasAgentsDocs && username && kodyId
				? getPackageTreeHref({
						username,
						kodyId,
						listingId: listingId ?? undefined,
						relativePath: 'AGENTS.md',
					})
				: null
		return (
			<article
				mix={[css(detailArticleCss), ...install.mixins, ...follow.mixins]}
			>
				<Frame name={COMMUNITY_DETAIL_TARGET} src={frameSrc} />

				{follow.render()}

				{renderShellStatus(shellStatusMessage)}

				{showShellReady ? (
					<>
						{listingId ? install.renderStrip() : null}

						{readmeContent
							? renderReadmeSection(
									renderReadme(
										readmeContent,
										readmeFences,
										readmeImageBaseHref,
									),
									agentsDocsHref,
								)
							: renderEmptyReadme(agentsDocsHref)}

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
