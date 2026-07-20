import { Frame, type Handle, css } from 'remix/ui'
import { routes } from '#app/routes.ts'
import { COMMUNITY_DETAIL_TARGET } from '#app/community-frame-constants.ts'
import { writeClipboardText } from '#client/clipboard.ts'
import {
	listenToRouterNavigation,
	readCurrentRouterHref,
} from '#client/client-router.tsx'
import { prefetchFrame } from '#client/frame-prefetch.ts'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { consumeStaleNavigationData } from '#client/navigation-data.ts'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { readRouterPathname } from '#client/router-location.tsx'
import { on } from '#client/event-mixin.ts'
import { MarkdownView } from '#client/markdown-view.tsx'
import { readJson } from '#client/routes/account-approval-shared.ts'
import { colors, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerButtonCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	layoutMaxWidths,
	mutedLinkCss,
	stackedPageCss,
	textareaCss,
} from '#client/styles/style-primitives.ts'
import {
	type PublicCommunityListing,
	type PublicCommunityStargazer,
} from '#app/community-public-types.ts'
import { type CommunityStargazersLoaderData } from '#app/loader-data.ts'
import { formatCommunityPublishedDate } from '#app/community-display.ts'
import { UserAvatar } from '#app/user-avatar.tsx'

type CommunityDetailApiPayload = {
	ok: true
	listing: PublicCommunityListing
	loggedIn: boolean
	viewerIsAdmin: boolean
	forkPrompt: string
	starredByViewer: boolean
}

type CommunityInstallApiPayload = {
	ok: boolean
	requiresAcknowledgement?: boolean
	status?: 'installed' | 'adaptation_required'
	targetName?: string
	agentPrompt?: string
	failedChecks?: Array<{ kind: string; message: string }>
	error?: string
}

type CommunityInstallOutcome = {
	status: 'installed' | 'adaptation_required'
	targetName: string
	agentPrompt: string
	failedChecks: Array<{ kind: string; message: string }>
}

function getListingIdFromPathname(pathname: string) {
	const prefix = `${routes.community.href()}/`
	if (!pathname.startsWith(prefix)) return null
	const listingId = decodeURIComponent(
		pathname.slice(prefix.length).replace(/\/$/, ''),
	)
	return listingId || null
}

function getCurrentListingId(handle: Handle) {
	return getListingIdFromPathname(readRouterPathname(handle))
}

export async function communityDetailRouteLoader(
	url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const listingId = getListingIdFromPathname(url.pathname)
	if (!listingId) {
		throw new Error('Community listing not found.')
	}

	const frameSrc = routes.communityDetail.href({ listingId })
	const shellPromise = fetch(routes.communityDetailApi.href({ listingId }), {
		headers: { Accept: 'application/json' },
		signal,
	})
	const framePrefetchPromise = prefetchFrame(
		frameSrc,
		COMMUNITY_DETAIL_TARGET,
		signal,
	)

	const response = await shellPromise
	if (response.status === 404) {
		throw new Error('Community listing not found.')
	}
	const payload = await readJson<CommunityDetailApiPayload>(response)
	if (!response.ok || !payload?.ok) {
		throw new Error('Unable to load community package.')
	}

	await framePrefetchPromise

	return {
		communityDetailShell: {
			ok: true,
			listingId,
			name: payload.listing.name,
			forkPrompt: payload.forkPrompt,
			loggedIn: payload.loggedIn,
			viewerIsAdmin: payload.viewerIsAdmin,
			trusted: payload.listing.trusted,
			featured: payload.listing.featured,
			readmeContent: payload.listing.readmeContent,
			starCount: payload.listing.starCount,
			starredByViewer: payload.starredByViewer,
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
	let installPromptCopyState: 'idle' | 'copied' = 'idle'
	let installPromptCopyTimerId: ReturnType<typeof window.setTimeout> | null =
		null
	let readmeContent: string | null = null
	let shellStatus: 'loading' | 'ready' | 'error' = 'loading'
	let shellLoadRequestId = 0
	let reportReason = ''
	let reportState: 'idle' | 'submitting' | 'success' | 'error' = 'idle'
	let reportMessage: string | null = null
	let copyState: 'idle' | 'copied' = 'idle'
	let copyResetTimerId: ReturnType<typeof window.setTimeout> | null = null
	let shellLoadedForListingId: string | null = null
	let shellRequestedForListingId: string | null = null
	let starCount = 0
	let starredByViewer = false
	let starState: 'idle' | 'submitting' | 'error' = 'idle'
	let starMessage: string | null = null
	let stargazers: Array<PublicCommunityStargazer> = []
	let stargazersTotal = 0
	let stargazersStatus: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
	let stargazersLoadedForListingId: string | null = null

	async function loadDetailShell() {
		const listingId = getCurrentListingId(handle)
		if (!listingId) return

		const requestId = ++shellLoadRequestId
		// Same-listing revalidations keep showing the current shell while the
		// fetch is in flight; only brand-new listings show the loading state.
		if (shellLoadedForListingId !== listingId) {
			shellStatus = 'loading'
			handle.update()
		}

		try {
			const response = await fetch(
				routes.communityDetailApi.href({ listingId }),
				{
					headers: { Accept: 'application/json' },
				},
			)
			if (requestId !== shellLoadRequestId) return
			if (response.status === 404) {
				shellLoadedForListingId = listingId
				shellStatus = 'error'
				handle.update()
				return
			}
			const payload = await readJson<CommunityDetailApiPayload>(response)
			if (!response.ok || !payload?.ok) {
				throw new Error('Unable to load community package.')
			}
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
			readmeContent = payload.listing.readmeContent
			starCount = payload.listing.starCount
			starredByViewer = payload.starredByViewer
			starState = 'idle'
			starMessage = null
			reportState = 'idle'
			reportMessage = null
			shellLoadedForListingId = listingId
			shellStatus = 'ready'
			handle.update()
			void loadStargazers(listingId)
		} catch {
			if (requestId !== shellLoadRequestId) return
			// Mark the listing as attempted so renders do not requeue the load
			// in a loop; the user can recover via navigation or reload.
			shellLoadedForListingId = listingId
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

	async function copyInstallPrompt() {
		if (!installOutcome) return
		try {
			await writeClipboardText(installOutcome.agentPrompt)
			if (installPromptCopyTimerId != null) {
				window.clearTimeout(installPromptCopyTimerId)
			}
			installPromptCopyState = 'copied'
			handle.update()
			installPromptCopyTimerId = window.setTimeout(() => {
				installPromptCopyTimerId = null
				if (handle.signal.aborted) return
				installPromptCopyState = 'idle'
				handle.update()
			}, 2000)
		} catch {
			installPromptCopyState = 'idle'
			handle.update()
		}
	}

	async function copyForkPrompt() {
		if (!forkPrompt) return
		try {
			await writeClipboardText(forkPrompt)
			if (copyResetTimerId != null) {
				window.clearTimeout(copyResetTimerId)
			}
			copyState = 'copied'
			handle.update()
			copyResetTimerId = window.setTimeout(() => {
				copyResetTimerId = null
				if (handle.signal.aborted) return
				copyState = 'idle'
				handle.update()
			}, 2000)
		} catch {
			copyState = 'idle'
			handle.update()
		}
	}

	listenToRouterNavigation(handle, () => {
		const listingId = getCurrentListingId(handle)
		if (!listingId) return

		const frame = handle.frames.get(COMMUNITY_DETAIL_TARGET)
		if (!frame) return

		const nextSrc = routes.communityDetail.href({ listingId })
		if (frame.src !== nextSrc) {
			frame.src = nextSrc
		}
		void frame.reload()
	})

	function applyRouteShellData(href: string, listingId: string | null) {
		if (!listingId) return false
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'communityDetailShell',
			href,
		)
		if (!routeData || routeData.listingId !== listingId) {
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
		readmeContent = routeData.readmeContent
		starCount = routeData.starCount
		starredByViewer = routeData.starredByViewer
		starState = 'idle'
		starMessage = null
		reportState = 'idle'
		reportMessage = null
		shellLoadedForListingId = listingId
		shellStatus = 'ready'
		if (stargazersLoadedForListingId !== listingId) {
			void loadStargazers(listingId)
		}
		return true
	}

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()
	const dangerButtonCss = getDangerButtonCss()

	return () => {
		const listingId = getCurrentListingId(handle)
		const currentHref = readCurrentRouterHref(handle)

		if (!listingId) {
			return (
				<section mix={css(pageCss)}>
					<h1 mix={css({ margin: 0, fontSize: typography.fontSize['2xl'] })}>
						Community package not found
					</h1>
					<p mix={css(descriptionCss)}>This listing is unavailable.</p>
					<p mix={css({ margin: 0 })}>
						<a href={routes.community.href()} mix={css(mutedLinkCss)}>
							Back to community packages
						</a>
					</p>
				</section>
			)
		}

		const appliedShellData = applyRouteShellData(currentHref, listingId)
		// A same-path refresh whose loader failed leaves no preload and the
		// listing id unchanged; the stale marker forces the fallback refetch.
		const needsStaleRefresh =
			consumeStaleNavigationData(currentHref) && !appliedShellData
		if (
			(needsStaleRefresh ||
				(shellLoadedForListingId !== listingId &&
					shellRequestedForListingId !== listingId)) &&
			typeof document !== 'undefined'
		) {
			// Show the loading state immediately so the previous listing's
			// shell (fork prompt, README, login state) never renders under the
			// new listing's header while the refetch is in flight. Same-listing
			// stale refreshes keep the current shell visible instead. Tracking
			// the requested listing separately keeps re-renders from enqueueing
			// duplicate fetches while one is already in flight.
			if (shellLoadedForListingId !== listingId) {
				shellStatus = 'loading'
			}
			shellRequestedForListingId = listingId
			handle.queueTask(loadDetailShell)
		}

		const frameSrc = routes.communityDetail.href({ listingId })

		// Never show another listing's shell data: even if an in-flight fetch
		// for the previous listing resolves late, mismatched ids render the
		// loading state until the current listing's shell arrives.
		const shellMatchesListing = shellLoadedForListingId === listingId
		const showShellReady = shellStatus === 'ready' && shellMatchesListing
		const showShellError = shellStatus === 'error' && shellMatchesListing

		return (
			<section mix={css(pageCss)}>
				<Frame name={COMMUNITY_DETAIL_TARGET} src={frameSrc} />

				{!showShellReady && !showShellError ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })}>
						Loading community package details…
					</p>
				) : null}

				{showShellError ? (
					<p mix={css({ color: colors.textMuted, margin: 0 })} role="status">
						Unable to load fork and report details for this listing.
					</p>
				) : null}

				{showShellReady ? (
					<>
						<section mix={css(cardCss)} data-testid="community-install">
							<h2 mix={css(cardTitleCss)}>One-click install</h2>
							{installOutcome ? (
								<>
									{installOutcome.status === 'installed' ? (
										<>
											<p
												mix={css(descriptionCss)}
												data-testid="community-install-success"
												role="status"
											>
												Installed as {installOutcome.targetName}. Any jobs or
												auto-start services the package declares are now active.
											</p>
											<p mix={css({ margin: 0 })}>
												<a
													href={routes.accountPackages.href()}
													mix={css(mutedLinkCss)}
												>
													View it in your packages
												</a>
											</p>
											<p mix={css(descriptionCss)}>
												Give this prompt to your agent to finish any remaining
												setup (secrets, connections, a first test run):
											</p>
										</>
									) : (
										<>
											<p
												mix={css(descriptionCss)}
												data-testid="community-install-adaptation"
												role="status"
											>
												Forked as {installOutcome.targetName}, but it needs
												adaptation before it can run in your account.
											</p>
											{installOutcome.failedChecks.length > 0 ? (
												<ul mix={css(checkListCss)}>
													{installOutcome.failedChecks.map((check) => (
														<li key={check.kind}>
															{check.kind}: {check.message}
														</li>
													))}
												</ul>
											) : null}
											<p mix={css(descriptionCss)}>
												Give this prompt to your agent to adapt and publish it:
											</p>
										</>
									)}
									<pre mix={css(promptBlockCss)}>
										{installOutcome.agentPrompt}
									</pre>
									<button
										mix={[
											on('click', () => void copyInstallPrompt()),
											css(primaryButtonCss),
										]}
									>
										{installPromptCopyState === 'copied'
											? 'Copied'
											: 'Copy prompt'}
									</button>
								</>
							) : (
								<>
									<p mix={css(descriptionCss)}>
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
															css(dangerButtonCss),
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
															css(secondaryButtonCss),
														]}
													>
														Cancel
													</button>
												</div>
											</div>
										) : (
											<button
												disabled={installState === 'submitting'}
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
													css(primaryButtonCss),
												]}
											>
												{installState === 'submitting'
													? 'Installing…'
													: 'Install'}
											</button>
										)
									) : (
										<p mix={css(descriptionCss)}>
											<a href="/login" mix={css(mutedLinkCss)}>
												Log in
											</a>{' '}
											to install this package.
										</p>
									)}
									{installMessage ? (
										<p
											mix={css({ margin: 0, color: colors.error })}
											role="alert"
										>
											{installMessage}
										</p>
									) : null}
								</>
							)}
						</section>

						<section mix={css(cardCss)} data-testid="community-star">
							<h2 mix={css(cardTitleCss)}>Stars</h2>
							<p mix={css(descriptionCss)} data-testid="community-star-count">
								{starCount} {starCount === 1 ? 'star' : 'stars'}
							</p>
							{loggedIn ? (
								<button
									type="button"
									disabled={starState === 'submitting'}
									mix={[
										on('click', () => void submitStar(!starredByViewer)),
										css(
											starredByViewer ? secondaryButtonCss : primaryButtonCss,
										),
									]}
								>
									{starState === 'submitting'
										? 'Saving…'
										: starredByViewer
											? 'Unstar'
											: 'Star'}
								</button>
							) : (
								<p mix={css(descriptionCss)}>
									<a href="/login" mix={css(mutedLinkCss)}>
										Log in
									</a>{' '}
									to star this package.
								</p>
							)}
							{starMessage ? (
								<p mix={css({ margin: 0, color: colors.error })} role="alert">
									{starMessage}
								</p>
							) : null}
							<p
								mix={css(descriptionCss)}
								data-testid="community-stargazers-total"
							>
								{stargazersTotal}{' '}
								{stargazersTotal === 1 ? 'stargazer' : 'stargazers'}
							</p>
							{stargazersStatus === 'loading' ? (
								<p mix={css(descriptionCss)}>Loading stargazers…</p>
							) : null}
							{stargazersStatus === 'ready' && stargazers.length > 0 ? (
								<ul
									mix={css(stargazerListCss)}
									data-testid="community-stargazers"
								>
									{stargazers.map((stargazer) => (
										<li key={stargazer.username} mix={css(stargazerRowCss)}>
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
													mix={css(mutedLinkCss)}
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

						<section mix={css(cardCss)}>
							<h2 mix={css(cardTitleCss)}>Fork with your agent</h2>
							<p mix={css(descriptionCss)}>
								Copy this prompt into your MCP-capable agent to fork and adapt
								the package safely.
							</p>
							<pre mix={css(promptBlockCss)}>{forkPrompt}</pre>
							<button
								mix={[
									on('click', () => void copyForkPrompt()),
									css(primaryButtonCss),
								]}
							>
								{copyState === 'copied' ? 'Copied' : 'Copy prompt'}
							</button>
						</section>

						{viewerIsAdmin ? (
							<section mix={css(cardCss)} data-testid="community-admin-trust">
								<h2 mix={css(cardTitleCss)}>Admin: trust</h2>
								<p mix={css(descriptionCss)}>
									{trusted
										? 'This listing is marked trusted at its current version. Revoking removes the badge immediately.'
										: 'Marking this listing trusted applies to the exact current version only. A republish by the owner drops the mark until it is re-reviewed.'}
								</p>
								<button
									disabled={trustState === 'submitting'}
									mix={[
										on('click', () => void submitTrust(!trusted)),
										css(secondaryButtonCss),
									]}
								>
									{trustState === 'submitting'
										? 'Saving…'
										: trusted
											? 'Revoke trust'
											: 'Mark as trusted'}
								</button>
								{trustMessage ? (
									<p mix={css({ margin: 0, color: colors.error })} role="alert">
										{trustMessage}
									</p>
								) : null}
							</section>
						) : null}

						{viewerIsAdmin ? (
							<section mix={css(cardCss)} data-testid="community-admin-feature">
								<h2 mix={css(cardTitleCss)}>Admin: onboarding</h2>
								<p mix={css(descriptionCss)}>
									{featured
										? 'This listing is featured as an onboarding starter package. Removing it hides it from onboarding immediately.'
										: trusted
											? 'Featuring offers this listing for one-click install during onboarding. A republish by the owner drops it from onboarding until the new version is re-trusted.'
											: 'Only trusted listings can be featured in onboarding. Mark the listing trusted first.'}
								</p>
								<button
									disabled={
										featureState === 'submitting' || (!featured && !trusted)
									}
									mix={[
										on('click', () => void submitFeature(!featured)),
										css(secondaryButtonCss),
									]}
								>
									{featureState === 'submitting'
										? 'Saving…'
										: featured
											? 'Remove from onboarding'
											: 'Feature in onboarding'}
								</button>
								{featureMessage ? (
									<p mix={css({ margin: 0, color: colors.error })} role="alert">
										{featureMessage}
									</p>
								) : null}
							</section>
						) : null}

						{readmeContent ? (
							<section mix={css(cardCss)}>
								<h2 mix={css(cardTitleCss)}>README</h2>
								<div data-testid="community-readme" mix={css(readmeBlockCss)}>
									<MarkdownView markdown={readmeContent} />
								</div>
							</section>
						) : null}

						<section mix={css(cardCss)}>
							<h2 id="report" mix={css(cardTitleCss)}>
								Report this listing
							</h2>
							{loggedIn ? (
								<>
									<label mix={css(fieldCss)}>
										<span mix={css(fieldLabelCss)}>Reason</span>
										<textarea
											value={reportReason}
											rows={4}
											maxLength={2000}
											placeholder="Describe why this listing should be reviewed."
											mix={[
												css(textareaCss),
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
											css(secondaryButtonCss),
										]}
									>
										{reportState === 'submitting'
											? 'Submitting…'
											: 'Submit report'}
									</button>
									{reportMessage ? (
										<p
											mix={css({
												margin: 0,
												color:
													reportState === 'error'
														? colors.error
														: colors.textMuted,
											})}
											role={reportState === 'error' ? 'alert' : 'status'}
										>
											{reportMessage}
										</p>
									) : null}
								</>
							) : (
								<p mix={css(descriptionCss)}>
									<a href="/login" mix={css(mutedLinkCss)}>
										Log in
									</a>{' '}
									to report this listing.
								</p>
							)}
						</section>
					</>
				) : null}
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: layoutMaxWidths.narrow,
	margin: '0 auto',
	width: '100%',
}

const promptBlockCss = {
	...insetCardCss,
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	wordBreak: 'break-word' as const,
	fontFamily: typography.fontFamily,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
}

const readmeBlockCss = {
	...insetCardCss,
	maxHeight: '32rem',
	overflow: 'auto',
}

const warningCardCss = {
	...insetCardCss,
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.75rem',
	borderColor: colors.danger,
}

const buttonRowCss = {
	display: 'flex',
	gap: '0.5rem',
	flexWrap: 'wrap' as const,
}

const stargazerListCss = {
	display: 'grid',
	gap: '0.35rem',
	margin: 0,
	padding: 0,
	listStyle: 'none',
	fontSize: typography.fontSize.sm,
}

const stargazerRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.5rem',
}

const checkListCss = {
	margin: 0,
	paddingLeft: '1.25rem',
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '0.25rem',
}
