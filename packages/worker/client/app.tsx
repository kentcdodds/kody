import { type Handle } from 'remix/component'
import { clientRoutes } from './routes/index.tsx'
import {
	getPathname,
	listenToRouterNavigation,
	Router,
} from './client-router.tsx'
import {
	fetchSessionInfo,
	type SessionInfo,
	type SessionStatus,
} from './session.ts'
import { buildAuthLink } from './auth-links.ts'
import { colors, mq, spacing, typography } from './styles/tokens.ts'

export function App(handle: Handle) {
	let session: SessionInfo | null = null
	let sessionStatus: SessionStatus = 'idle'
	let sessionRefreshInFlight = false
	let sessionRefreshQueued = false
	let currentPathname = getPathname()

	function queueSessionRefresh() {
		sessionRefreshQueued = true
		if (sessionRefreshInFlight) return

		// Preserve current nav state during refreshes after first load.
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

	handle.queueTask(() => {
		queueSessionRefresh()
	})
	listenToRouterNavigation(handle, () => {
		currentPathname = getPathname()
		queueSessionRefresh()
		handle.update()
	})

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

	return () => {
		const isChatLayout = currentPathname.startsWith('/chat')
		const sessionEmail = session?.email ?? ''
		const isSessionReady = sessionStatus === 'ready'
		const isLoggedIn = isSessionReady && Boolean(sessionEmail)
		const showAuthLinks = isSessionReady && !isLoggedIn
		const oauthRedirectTo =
			typeof window !== 'undefined' && currentPathname === '/oauth/authorize'
				? `${currentPathname}${window.location.search}`
				: null
		const loginHref = buildAuthLink('/login', oauthRedirectTo)
		const signupHref = buildAuthLink('/signup', oauthRedirectTo)

		return (
			<main
				css={{
					maxWidth: isChatLayout ? 'none' : '52rem',
					width: '100%',
					margin: isChatLayout ? 0 : '0 auto',
					padding: isChatLayout
						? `${spacing.lg} ${spacing.xl} ${spacing.sm}`
						: spacing['2xl'],
					minHeight: isChatLayout ? '100vh' : undefined,
					fontFamily: typography.fontFamily,
					boxSizing: 'border-box',
					[mq.tablet]: isChatLayout
						? {
								padding: `${spacing.sm} ${spacing.sm} 0`,
							}
						: {
								padding: spacing.xl,
							},
					[mq.mobile]: isChatLayout
						? {
								padding: `${spacing.md} ${spacing.md} ${spacing.sm}`,
							}
						: {
								padding: spacing.md,
							},
				}}
			>
				<nav
					css={{
						display: 'flex',
						alignItems: 'center',
						gap: spacing.md,
						flexWrap: 'wrap',
						marginBottom: isChatLayout ? spacing.lg : spacing.xl,
						[mq.tablet]: isChatLayout
							? {
									gap: spacing.sm,
									marginBottom: spacing.sm,
								}
							: {},
						[mq.mobile]: {
							gap: spacing.sm,
							marginBottom: isChatLayout ? spacing.md : spacing.lg,
						},
					}}
				>
					<a href="/" css={navHomeLinkCss} aria-label="Home">
						<img
							src="/logo.png"
							alt=""
							width={112}
							height={28}
							css={{
								display: 'block',
								height: '1.35em',
								width: 'auto',
							}}
						/>
					</a>
					{showAuthLinks ? (
						<>
							<a href={loginHref} css={navLinkCss}>
								Login
							</a>
							<a href={signupHref} css={navLinkCss}>
								Signup
							</a>
						</>
					) : null}
					{isLoggedIn ? (
						<>
							<a href="/chat" css={navLinkCss}>
								Chat
							</a>
							<a href="/account" css={navLinkCss}>
								{sessionEmail}
							</a>
							<form method="post" action="/logout" css={{ margin: 0 }}>
								<button type="submit" css={logOutButtonCss}>
									Log out
								</button>
							</form>
						</>
					) : null}
				</nav>
				<Router
					setup={{
						routes: clientRoutes,
						fallback: (
							<section>
								<h2
									css={{
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										marginBottom: spacing.sm,
										color: colors.text,
									}}
								>
									Not Found
								</h2>
								<p css={{ color: colors.textMuted }}>
									That route does not exist.
								</p>
							</section>
						),
					}}
				/>
			</main>
		)
	}
}
