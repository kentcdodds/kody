import { type Handle, css } from 'remix/ui'
import { clientRouteLoaders, clientRoutes } from './routes/index.tsx'
import {
	listenToRouterMutations,
	listenToRouterNavigation,
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
import {
	getSecondaryButtonCss,
	layoutMaxWidths,
	primaryLinkCss,
} from './styles/style-primitives.ts'
import { type AppLoaderData } from '#app/loader-data.ts'
import { userHasRole } from '#app/permissions.ts'
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
		// Router form POSTs mutate server state, which may include auth (e.g.
		// logout destroys the session cookie), so the next navigation must
		// bypass the refresh throttle. The refresh cannot start here: the
		// follow-up redirect navigation re-renders the shell, which aborts
		// in-flight queued tasks and would silently drop the refresh.
		listenToRouterMutations(handle, () => {
			sessionMaybeStale = true
		})
	}

	const navHomeLinkCss = {
		...primaryLinkCss,
		display: 'flex',
		alignItems: 'center',
		lineHeight: 0,
		'&:hover': {
			textDecoration: 'none',
			opacity: 0.85,
		},
	}

	const logOutButtonCss = {
		...getSecondaryButtonCss(),
		padding: `${spacing.xs} ${spacing.md}`,
	}

	const compactNavCss = {
		gap: spacing.sm,
		marginBottom: spacing.lg,
	}

	const navGroupCss = {
		display: 'flex',
		alignItems: 'center',
		gap: spacing.md,
		flexWrap: 'wrap',
		[mq.tablet]: {
			gap: spacing.sm,
		},
		[mq.mobile]: {
			gap: spacing.sm,
		},
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
		const signupHref = buildAuthLink('/signup', oauthRedirectTo)
		const hideWaitlistBanner =
			!showAuthLinks ||
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
						fontFamily: typography.fontFamily,
						boxSizing: 'border-box',
					})}
				>
					{hideWaitlistBanner ? null : <WaitlistBanner />}
					<div
						mix={css({
							width: '100%',
							padding: `${spacing.lg} ${spacing.xl} ${spacing.sm}`,
							boxSizing: 'border-box',
							[mq.tablet]: {
								padding: `${spacing.sm} ${spacing.sm} 0`,
							},
							[mq.mobile]: {
								padding: `${spacing.md} ${spacing.md} ${spacing.sm}`,
							},
						})}
					>
						<nav
							mix={css({
								maxWidth: layoutMaxWidths.wide,
								width: '100%',
								margin: `0 auto ${spacing.xl}`,
								boxSizing: 'border-box',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								gap: spacing.md,
								flexWrap: 'wrap',
								[mq.tablet]: compactNavCss,
								[mq.mobile]: compactNavCss,
							})}
						>
							<div mix={css(navGroupCss)}>
								<a href="/" aria-label="Home" mix={css(navHomeLinkCss)}>
									<img
										src="/logo.png"
										alt=""
										width={112}
										height={28}
										mix={css({
											display: 'block',
											height: '1.35em',
											width: 'auto',
										})}
									/>
								</a>
								<a href="/community" mix={css(primaryLinkCss)}>
									Community
								</a>
								<a href="/blog" mix={css(primaryLinkCss)}>
									Blog
								</a>
								{isLoggedIn ? (
									<a href="/timeline" mix={css(primaryLinkCss)}>
										Timeline
									</a>
								) : null}
							</div>
							<div mix={css(navGroupCss)}>
								{showAuthLinks ? (
									<>
										<a href={loginHref} mix={css(primaryLinkCss)}>
											Login
										</a>
										<a href={signupHref} mix={css(primaryLinkCss)}>
											Signup
										</a>
									</>
								) : null}
								{isLoggedIn ? (
									<>
										{showAdminLink ? (
											<a href="/admin/users" mix={css(primaryLinkCss)}>
												Admin
											</a>
										) : null}
										<a href="/account" mix={css(primaryLinkCss)}>
											{sessionDisplayName}
										</a>
										{showDemoIndicator ? (
											<span
												data-testid="demo-indicator"
												mix={css({
													fontSize: typography.fontSize.xs,
													fontWeight: typography.fontWeight.medium,
													color: colors.textMuted,
													border: `1px solid ${colors.border}`,
													borderRadius: '0.375rem',
													padding: `0 ${spacing.xs}`,
													lineHeight: 1.6,
													letterSpacing: '0.02em',
													textTransform: 'uppercase',
												})}
											>
												Demo
											</span>
										) : null}
										<form
											method="post"
											action="/logout"
											mix={css({ margin: 0 })}
										>
											<button type="submit" mix={css(logOutButtonCss)}>
												Log out
											</button>
										</form>
									</>
								) : null}
							</div>
						</nav>
						<main mix={css({ width: '100%', boxSizing: 'border-box' })}>
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
					</div>
				</div>
			</AppLoaderDataProvider>
		)
	}
}
