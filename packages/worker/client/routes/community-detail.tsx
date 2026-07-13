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
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	insetCardCss,
	layoutMaxWidths,
	mutedLinkCss,
	stackedPageCss,
	textareaCss,
} from '#client/styles/style-primitives.ts'
import { type PublicCommunityListing } from '#app/community-public-types.ts'

type CommunityDetailApiPayload = {
	ok: true
	listing: PublicCommunityListing
	loggedIn: boolean
	forkPrompt: string
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
			forkPrompt: payload.forkPrompt,
			loggedIn: payload.loggedIn,
			readmeContent: payload.listing.readmeContent,
		},
	}
}

function buildReportApiPath(listingId: string) {
	return routes.communityReportApiPost.href({ listingId })
}

export function CommunityDetailRoute(handle: Handle) {
	let forkPrompt = ''
	let loggedIn = false
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
			readmeContent = payload.listing.readmeContent
			reportState = 'idle'
			reportMessage = null
			shellLoadedForListingId = listingId
			shellStatus = 'ready'
			handle.update()
		} catch {
			if (requestId !== shellLoadRequestId) return
			// Mark the listing as attempted so renders do not requeue the load
			// in a loop; the user can recover via navigation or reload.
			shellLoadedForListingId = listingId
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
		readmeContent = routeData.readmeContent
		reportState = 'idle'
		reportMessage = null
		shellLoadedForListingId = listingId
		shellStatus = 'ready'
		return true
	}

	const primaryButtonCss = getPrimaryButtonCss()
	const secondaryButtonCss = getSecondaryButtonCss()

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
