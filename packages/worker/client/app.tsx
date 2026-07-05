import { type Handle, css } from 'remix/ui'
import { clientRouteLoaders, clientRoutes } from './routes/index.tsx'
import {
	listenToRouterNavigation,
	registerRouteLoaders,
	Router,
} from './client-router.tsx'
import { AppLoaderDataProvider } from './loader-data-context.tsx'
import { NavigationProgress } from './navigation-progress.tsx'
import { readRouterPathname, readRouterSearch } from './router-location.tsx'
import { ScrollRestoration } from './scroll-restoration.tsx'
import {
	fetchSessionInfo,
	getSessionDisplayName,
	setSessionRefreshHandler,
	type SessionInfo,
	type SessionStatus,
} from './session.ts'
import { layoutMaxWidths } from './styles/style-primitives.ts'
import { type AppLoaderData } from '#app/loader-data.ts'
import { userHasRole } from '#app/permissions.ts'
import { buildAuthLink } from './auth-links.ts'
import { colors, mq, spacing, typography } from './styles/tokens.ts'

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
	let currentPathname = readRouterPathname(handle)

	// Navigation-triggered refreshes are throttled: auth rarely changes
	// mid-session and every SPA navigation was previously a /session round
	// trip (2 D1 queries). Explicit refreshes (login/logout/profile updates
	// via setSessionRefreshHandler) always bypass the throttle.
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
			sessionStatus === 'ready' &&
			Date.now() - lastSessionRefreshAt < sessionRefreshThrottleMs
		) {
			return
		}
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
	}

	const navLinkCss = {
		color: colors.primaryText,
		fontWeight: typography.fontWeight.medium,
		textDecoration: 'none',
		'&:hover': {
			textDecoration: 'underline',
		},
	}

	const navHomeLinkCss = {
		...navLinkCss,
		display: 'flex',
		alignItems: 'center',
		lineHeight: 0,
		'&:hover': {
			textDecoration: 'none',
			opacity: 0.85,
		},
	}

	const logOutButtonCss = {
		padding: `${spacing.xs} ${spacing.md}`,
		borderRadius: '999px',
		border: `1px solid ${colors.border}`,
		backgroundColor: 'transparent',
		color: colors.text,
		fontWeight: typography.fontWeight.medium,
		cursor: 'pointer',
	}

	const compactNavCss = {
		gap: spacing.sm,
		marginBottom: spacing.lg,
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
		const oauthRedirectTo =
			currentPathname === '/oauth/authorize'
				? `${currentPathname}${readRouterSearch(handle)}`
				: null
		const loginHref = buildAuthLink('/login', oauthRedirectTo)
		const signupHref = buildAuthLink('/signup', oauthRedirectTo)

		return (
			<AppLoaderDataProvider loaderData={handle.props.loaderData}>
				<NavigationProgress />
				<ScrollRestoration />
				<div
					mix={css({
						width: '100%',
						minHeight: '100vh',
						padding: `${spacing.lg} ${spacing.xl} ${spacing.sm}`,
						fontFamily: typography.fontFamily,
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
							gap: spacing.md,
							flexWrap: 'wrap',
							[mq.tablet]: compactNavCss,
							[mq.mobile]: compactNavCss,
						})}
					>
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
						<a href="/community" mix={css(navLinkCss)}>
							Community
						</a>
						{showAuthLinks ? (
							<>
								<a href={loginHref} mix={css(navLinkCss)}>
									Login
								</a>
								<a href={signupHref} mix={css(navLinkCss)}>
									Signup
								</a>
							</>
						) : null}
						{isLoggedIn ? (
							<>
								<a href="/account" mix={css(navLinkCss)}>
									{sessionDisplayName}
								</a>
								<a href="/account/secrets" mix={css(navLinkCss)}>
									Secrets
								</a>
								<a href="/account/integrations" mix={css(navLinkCss)}>
									Integrations
								</a>
								<a
									href="/account/package-invocation-tokens"
									mix={css(navLinkCss)}
								>
									Package tokens
								</a>
								<a href="/account/remote-connectors" mix={css(navLinkCss)}>
									Connectors
								</a>
								{showAdminLink ? (
									<a href="/admin/users" mix={css(navLinkCss)}>
										Admin
									</a>
								) : null}
								<form method="post" action="/logout" mix={css({ margin: 0 })}>
									<button type="submit" mix={css(logOutButtonCss)}>
										Log out
									</button>
								</form>
							</>
						) : null}
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
			</AppLoaderDataProvider>
		)
	}
}
