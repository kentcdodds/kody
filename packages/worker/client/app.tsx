import { type Handle, css } from 'remix/ui'
import { on } from './event-mixin.ts'
import { clientRouteLoaders, clientRoutes } from './routes/index.tsx'
import { getSlugFromPathname } from './routes/blog-post.tsx'
import { getListingIdFromPathname } from './routes/community-detail.tsx'
import {
	listenToRouterMutations,
	listenToRouterNavigation,
	listenToRouterNavigationEnd,
	navigate,
	registerRouteLoaders,
	Router,
} from './client-router.tsx'
import { AppLoaderDataProvider } from './loader-data-context.tsx'
import { NavigationProgress } from './navigation-progress.tsx'
import { readRouterPathname, readRouterSearch } from './router-location.tsx'
import { ScrollRestoration } from './scroll-restoration.tsx'
import { isFeatureFlagEnabled } from './feature-flags.ts'
import {
	fetchSessionInfo,
	getSessionDisplayName,
	setSessionRefreshHandler,
	type SessionInfo,
	type SessionStatus,
} from './session.ts'
import { visuallyHiddenUntilFocusedCss } from './styles/style-primitives.ts'
import { SiteFooter } from './site-footer.tsx'
import { SiteHeader } from './site-header.tsx'
import { type AppLoaderData } from '#app/loader-data.ts'
import { userHasRole } from '#worker/identity/permissions.ts'
import { buildAuthLink } from './auth-links.ts'
import { colors, mq, spacing, typography } from './styles/tokens.ts'
import { WaitlistBanner } from './waitlist-banner.tsx'

registerRouteLoaders(clientRouteLoaders)

type AppProps = {
	embeddedSession?: SessionInfo | null
	loaderData?: AppLoaderData
	notFound?: boolean
}

export function App(handle: Handle<AppProps>) {
	let session: SessionInfo | null = handle.props.embeddedSession ?? null
	let sessionStatus: SessionStatus =
		handle.props.embeddedSession !== undefined ? 'ready' : 'idle'
	let sessionRefreshInFlight = false
	let sessionRefreshQueued = false
	let lastSessionRefreshAt = 0
	let sessionMaybeStale = false
	let currentPathname = readRouterPathname(handle)
	let lastFocusManagedPathname = currentPathname

	// Navigation-triggered refreshes are throttled: auth rarely changes
	// mid-session and every SPA navigation was previously a /session round
	// trip (2 D1 queries). Refreshes after mutations (router form POSTs such
	// as logout) and explicit refreshes (profile updates via
	// setSessionRefreshHandler) always bypass the throttle.
	const sessionRefreshThrottleMs = 30_000

	function queueSessionRefresh() {
		sessionRefreshQueued = true
		if (sessionRefreshInFlight) return

		if (sessionStatus === 'idle') {
			sessionStatus = 'loading'
			handle.update()
		}

		sessionRefreshQueued = false
		sessionRefreshInFlight = true
		handle.queueTask(async (signal) => {
			const nextSession = await fetchSessionInfo(signal)
			sessionRefreshInFlight = false
			if (signal.aborted) return
			lastSessionRefreshAt = Date.now()
			session = nextSession
			sessionStatus = 'ready'
			handle.update()
			if (sessionRefreshQueued) {
				queueSessionRefresh()
			}
		})
		if (sessionStatus !== 'loading') {
			handle.update()
		}
	}

	function queueThrottledSessionRefresh() {
		if (
			!sessionMaybeStale &&
			sessionStatus === 'ready' &&
			Date.now() - lastSessionRefreshAt < sessionRefreshThrottleMs
		) {
			return
		}
		sessionMaybeStale = false
		queueSessionRefresh()
	}

	// Always revalidate after hydration: the embedded session renders the
	// first paint without a flash ('ready' status keeps the refresh silent),
	// but auth may have changed since the document was rendered.
	if (typeof document !== 'undefined') {
		setSessionRefreshHandler(queueSessionRefresh)
		handle.queueTask(() => {
			queueSessionRefresh()
		})
		listenToRouterNavigation(handle, () => {
			currentPathname = readRouterPathname(handle)
			queueThrottledSessionRefresh()
			handle.update()
		})
		listenToRouterNavigationEnd(handle, (detail) => {
			const nextPathname = new URL(detail.location, window.location.origin)
				.pathname
			if (nextPathname === lastFocusManagedPathname) return
			lastFocusManagedPathname = nextPathname
			handle.queueTask(() => {
				const main = document.getElementById('main')
				if (!(main instanceof HTMLElement)) return
				main.focus({ preventScroll: true })
			})
		})
		// Router form POSTs mutate server state, which may include auth (e.g.
		// logout destroys the session cookie), so the next navigation must
		// bypass the refresh throttle. The refresh cannot start here: the
		// follow-up redirect navigation re-renders the shell, which aborts
		// in-flight queued tasks and would silently drop the refresh.
		listenToRouterMutations(handle, () => {
			sessionMaybeStale = true
		})
	}

	return () => {
		currentPathname = readRouterPathname(handle)
		const sessionEmail = session?.email ?? ''
		const sessionDisplayName = getSessionDisplayName(session)
		const isSessionReady = sessionStatus === 'ready'
		const isLoggedIn = isSessionReady && Boolean(sessionEmail)
		const showAuthLinks = isSessionReady && !isLoggedIn
		const showAdminLink =
			isLoggedIn && session != null && userHasRole(session, 'admin')
		const showDemoIndicator = isFeatureFlagEnabled(session, 'demo-indicator')
		const oauthRedirectTo =
			currentPathname === '/oauth/authorize'
				? `${currentPathname}${readRouterSearch(handle)}`
				: null
		const loginHref = buildAuthLink('/login', oauthRedirectTo)
		// Redesigned pages own their own layout (gutters, measures, max-width
		// container), so `<main>` must not add its generic padding on top. The
		// landing page also owns its own waitlist close (the "Equip your agent"
		// section), so the compact strip would double up there.
		const isRedesignedMarketingPath =
			currentPathname === '/' ||
			currentPathname === '/pricing' ||
			currentPathname === '/blog' ||
			currentPathname === '/community' ||
			currentPathname === '/timeline' ||
			currentPathname === '/onboarding' ||
			getListingIdFromPathname(currentPathname) !== null ||
			getSlugFromPathname(currentPathname) !== null
		// The redesigned auth screens (login/signup) are a standalone
		// two-panel canvas with their own brand link, theme toggle, and "back"
		// corner — the prototype renders them without the site chrome, so the
		// header/footer stand down entirely there.
		const isAuthShellPath =
			currentPathname === '/login' || currentPathname === '/signup'
		const hideWaitlistBanner =
			!showAuthLinks ||
			isRedesignedMarketingPath ||
			currentPathname === '/signup' ||
			currentPathname === '/login' ||
			currentPathname === '/oauth/authorize' ||
			currentPathname === '/connect/oauth'

		return (
			<AppLoaderDataProvider loaderData={handle.props.loaderData}>
				<NavigationProgress />
				<ScrollRestoration />
				<div
					mix={css({
						width: '100%',
						minHeight: '100vh',
						display: 'flex',
						flexDirection: 'column',
						fontFamily: typography.fontFamily,
						boxSizing: 'border-box',
						/*
						 * The redesign's decorative glows are pseudo-elements with
						 * negative horizontal insets (`heroArtCss`, `pageHeadCss`, and
						 * the per-page overrides that borrow them), so they bleed past
						 * the viewport by design. Left unclipped that bleed becomes real
						 * horizontal page scroll on a phone — measured at 12-66px across
						 * the marketing routes — which also knocks the fixed mobile-menu
						 * popover out of line with the sticky header once you swipe
						 * sideways. `clip` rather than `hidden`: it contains the bleed
						 * without creating a scroll container, so the sticky header still
						 * resolves against the viewport and vertical bleed still shows.
						 */
						overflowX: 'clip',
					})}
				>
					<a
						href="#main"
						mix={[
							on('click', (event) => {
								const main = document.getElementById('main')
								if (!(main instanceof HTMLElement)) return
								event.preventDefault()
								navigate('#main')
								main.focus({ preventScroll: true })
								main.scrollIntoView()
							}),
							css(visuallyHiddenUntilFocusedCss),
						]}
					>
						Skip to content
					</a>
					{hideWaitlistBanner ? null : <WaitlistBanner />}
					{isAuthShellPath ? null : (
						<SiteHeader
							loggedIn={isLoggedIn}
							displayName={sessionDisplayName}
							showAdminLink={showAdminLink}
							showDemoIndicator={isLoggedIn && showDemoIndicator}
							loginHref={loginHref}
							currentPathname={currentPathname}
						/>
					)}
					<main
						id="main"
						tabIndex={-1}
						mix={css(
							isAuthShellPath
								? {
										width: '100%',
										boxSizing: 'border-box',
										flex: 1,
										// The auth canvas stretches to fill the shell column.
										display: 'grid',
									}
								: isRedesignedMarketingPath
									? { width: '100%', boxSizing: 'border-box', flex: 1 }
									: {
											width: '100%',
											boxSizing: 'border-box',
											flex: 1,
											padding: `${spacing.lg} ${spacing.xl} ${spacing.sm}`,
											[mq.tablet]: {
												padding: `${spacing.sm} ${spacing.sm} 0`,
											},
											[mq.mobile]: {
												padding: `${spacing.md} ${spacing.md} ${spacing.sm}`,
											},
										},
						)}
					>
						<Router
							routes={clientRoutes}
							loaderData={handle.props.loaderData}
							notFound={handle.props.notFound}
							fallback={
								<section>
									<h2
										mix={css({
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											marginBottom: spacing.sm,
											color: colors.text,
										})}
									>
										Not Found
									</h2>
									<p mix={css({ color: colors.textMuted })}>
										We could not find that page.
									</p>
								</section>
							}
						/>
					</main>
					{isAuthShellPath ? null : (
						<SiteFooter loggedIn={isLoggedIn} loginHref={loginHref} />
					)}
				</div>
			</AppLoaderDataProvider>
		)
	}
}
