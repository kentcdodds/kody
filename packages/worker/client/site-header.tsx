import { type Handle, css } from 'remix/ui'
import { listenToRouterNavigation } from '#client/client-router.tsx'
import { on } from '#client/event-mixin.ts'
import {
	colors,
	shadows,
	spacing,
	transitions,
	typography,
} from '#client/styles/tokens.ts'
import {
	hoverMq,
	layoutMaxWidths,
	pageGutter,
} from '#client/styles/style-primitives.ts'

export type SiteHeaderProps = {
	loggedIn: boolean
	displayName: string
	showAdminLink: boolean
	showDemoIndicator: boolean
	loginHref: string
	currentPathname: string
}

/**
 * Sticky site header from the heykody.dev redesign: brand, marketing nav
 * (Community · Pricing · Blog), and the session corner. The bottom hairline
 * appears only after the page scrolls, so the header reads as part of the
 * canvas at rest.
 */
const marketingLinks = [
	{ href: '/community', label: 'Community' },
	{ href: '/pricing', label: 'Pricing' },
	{ href: '/blog', label: 'Blog' },
] as const

/**
 * `aria-current="page"` for a nav link: exact match, or a subpath of the
 * link's section (`/blog/why` marks Blog).
 */
function ariaCurrent(currentPathname: string, href: string) {
	return currentPathname === href || currentPathname.startsWith(`${href}/`)
		? ('page' as const)
		: undefined
}

/** One id: the invoker points at the panel with `popovertarget`. */
const menuPanelId = 'site-menu'

export function SiteHeader(handle: Handle<SiteHeaderProps>) {
	let scrolled = false
	let menuOpen = false

	if (typeof document !== 'undefined') {
		const onScroll = () => {
			const next = window.scrollY > 8
			if (next === scrolled) return
			scrolled = next
			handle.update()
		}
		window.addEventListener('scroll', onScroll, {
			passive: true,
			signal: handle.signal,
		})
		handle.queueTask(onScroll)

		// Following a link inside the menu is a client-side navigation, so
		// nothing would otherwise dismiss the panel.
		listenToRouterNavigation(handle, () => {
			const panel = document.getElementById(menuPanelId)
			if (panel instanceof HTMLElement && panel.matches(':popover-open')) {
				panel.hidePopover()
			}
		})
	}

	// The browser owns open/close (light dismiss, Escape, the invoker); this
	// only mirrors the state the button has to announce and draw.
	function onMenuToggle(event: { newState?: string }) {
		const next = event.newState === 'open'
		if (next === menuOpen) return
		menuOpen = next
		handle.update()
	}

	return () => (
		<header data-scrolled={scrolled ? 'true' : undefined} mix={css(headerCss)}>
			<nav aria-label="Main" mix={css(navCss)}>
				<a href="/" mix={css(brandCss)}>
					<img
						src="/images/kody-mark.png"
						alt=""
						width={34}
						height={34}
						mix={css({ borderRadius: '50%' })}
					/>
					<span>Kody</span>
				</a>
				<div mix={css(navLinksCss)}>
					{marketingLinks.map((link) => (
						<a
							key={link.href}
							href={link.href}
							aria-current={ariaCurrent(
								handle.props.currentPathname,
								link.href,
							)}
						>
							{link.label}
						</a>
					))}
					{handle.props.loggedIn ? (
						<a
							href="/timeline"
							aria-current={ariaCurrent(
								handle.props.currentPathname,
								'/timeline',
							)}
						>
							Timeline
						</a>
					) : null}
					{handle.props.showAdminLink ? (
						<a
							href="/admin/users"
							aria-current={ariaCurrent(
								handle.props.currentPathname,
								'/admin/users',
							)}
						>
							Admin
						</a>
					) : null}
				</div>
				<div mix={css(navActionsCss)}>
					{handle.props.loggedIn ? (
						<>
							<a href="/account" mix={css(navUserCss)}>
								{handle.props.displayName}
							</a>
							{handle.props.showDemoIndicator ? (
								<span data-testid="demo-indicator" mix={css(demoIndicatorCss)}>
									Demo
								</span>
							) : null}
							<form method="post" action="/logout" mix={css({ margin: 0 })}>
								<button type="submit" mix={css(logOutButtonCss)}>
									Log out
								</button>
							</form>
						</>
					) : (
						<a href={handle.props.loginHref} mix={css(navLoginCss)}>
							Log in
						</a>
					)}
				</div>
				<button
					type="button"
					popovertarget={menuPanelId}
					aria-label="Menu"
					aria-expanded={menuOpen ? 'true' : 'false'}
					data-open={menuOpen ? '' : undefined}
					mix={css(menuToggleCss)}
				>
					<span aria-hidden="true" mix={css(burgerCss)}>
						<span />
						<span />
						<span />
					</span>
				</button>
				<div
					id={menuPanelId}
					popover
					mix={[css(menuPanelCss), on('toggle', onMenuToggle)]}
				>
					<div mix={css(menuGroupCss)}>
						{marketingLinks.map((link) => (
							<a
								key={link.href}
								href={link.href}
								aria-current={ariaCurrent(
									handle.props.currentPathname,
									link.href,
								)}
							>
								{link.label}
							</a>
						))}
						{handle.props.loggedIn ? (
							<a
								href="/timeline"
								aria-current={ariaCurrent(
									handle.props.currentPathname,
									'/timeline',
								)}
							>
								Timeline
							</a>
						) : null}
						{handle.props.showAdminLink ? (
							<a
								href="/admin/users"
								aria-current={ariaCurrent(
									handle.props.currentPathname,
									'/admin/users',
								)}
							>
								Admin
							</a>
						) : null}
					</div>
					<div mix={css(menuGroupCss)}>
						{handle.props.loggedIn ? (
							<>
								<a
									href="/account"
									aria-current={ariaCurrent(
										handle.props.currentPathname,
										'/account',
									)}
								>
									{handle.props.displayName}
								</a>
								<form
									method="post"
									action="/logout"
									mix={css({ margin: 0, display: 'grid' })}
								>
									<button type="submit" mix={css(menuLogOutCss)}>
										Log out
									</button>
								</form>
							</>
						) : (
							<a href={handle.props.loginHref}>Log in</a>
						)}
					</div>
				</div>
			</nav>
		</header>
	)
}

const headerCss = {
	position: 'sticky' as const,
	top: 0,
	zIndex: 10,
	viewTransitionName: 'site-header',
	background: `oklch(from ${colors.background} l c h / 0.85)`,
	borderBottom: '1px solid transparent',
	transition: `border-color 200ms ${transitions.easeOut}`,
	// css() is static — the scrolled state must flow through an attribute,
	// not a swapped style object (which never re-applies after hydration).
	'&[data-scrolled]': {
		borderBottomColor: colors.border,
	},
	'@supports (backdrop-filter: blur(1px))': {
		backdropFilter: 'blur(14px)',
	},
}

const navCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `0.8rem ${pageGutter}`,
	display: 'flex',
	alignItems: 'center',
	gap: '1.8rem',
	flexWrap: 'wrap' as const,
}

const brandCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.6rem',
	font: `700 1.25rem/1 ${typography.fontFamilyDisplay}`,
	color: colors.text,
	textDecoration: 'none',
	letterSpacing: '-0.01em',
	'&:hover': { color: colors.text },
}

/**
 * Below this the inline nav and session corner would crowd the brand, so both
 * fold into the menu panel. Wider than the mobile token: it is the width the
 * links themselves stop fitting, not a device class.
 */
const headerNavMq = '@media (max-width: 820px)'

const navLinksCss = {
	display: 'flex',
	gap: '1.6rem',
	marginRight: 'auto',
	'& a': {
		color: colors.textMuted,
		textDecoration: 'none',
		fontWeight: 500,
		fontSize: '0.98rem',
		transition: `color ${transitions.fast}`,
	},
	'& a:hover': { color: colors.text },
	'& a[aria-current="page"]': { color: colors.text },
	[headerNavMq]: { display: 'none' },
}

const navActionsCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.9rem',
	// The links are gone at this width, so the actions take the free space
	// and keep the toggle pinned to the right edge.
	[headerNavMq]: { display: 'none' },
}

const menuToggleCss = {
	display: 'none',
	marginLeft: 'auto',
	alignItems: 'center',
	justifyContent: 'center',
	width: '44px',
	height: '44px',
	padding: 0,
	borderRadius: '12px',
	border: `1.5px solid ${colors.border}`,
	background: 'transparent',
	color: colors.text,
	cursor: 'pointer',
	transition: `border-color ${transitions.fast}, background-color ${transitions.fast}, scale ${transitions.fast}`,
	'&:active': { scale: '0.94' },
	[hoverMq]: {
		'&:hover': { borderColor: colors.textMuted },
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&:active': { scale: 'none' },
	},
	[headerNavMq]: { display: 'inline-flex' },
}

/** Three rules that fold into a cross. Transform-only, so it stays composited. */
const burgerCss = {
	display: 'grid',
	gap: '4px',
	width: '18px',
	'& > span': {
		display: 'block',
		height: '2px',
		borderRadius: '2px',
		backgroundColor: 'currentColor',
		transition: `translate 180ms ${transitions.easeOut}, rotate 180ms ${transitions.easeOut}, opacity 120ms ${transitions.easeOut}, scale 120ms ${transitions.easeOut}`,
	},
	// The end state still changes under reduced motion — only the tweening goes.
	'@media (prefers-reduced-motion: reduce)': {
		'& > span': { transition: 'none' },
	},
	'[data-open] &> span:nth-child(1)': { translate: '0 6px', rotate: '45deg' },
	'[data-open] &> span:nth-child(2)': { opacity: 0, scale: '0.4' },
	'[data-open] &> span:nth-child(3)': { translate: '0 -6px', rotate: '-45deg' },
}

/**
 * The menu is a native popover: the top layer, light dismiss, Escape, and
 * focus return all come from the platform, and the entrance is a plain
 * transition thanks to `@starting-style` plus discrete `display`/`overlay`.
 * 180ms, the dropdown budget — this opens often enough that it must not
 * make anyone wait.
 */
const menuPanelCss = {
	position: 'fixed' as const,
	inset: 'auto' as const,
	top: '4.15rem',
	left: pageGutter,
	right: pageGutter,
	width: 'auto',
	maxWidth: 'none',
	maxHeight: 'calc(100dvh - 5.5rem)',
	overflowY: 'auto' as const,
	margin: 0,
	padding: '0.5rem',
	display: 'grid',
	gap: '0.35rem',
	border: `1.5px solid ${colors.border}`,
	borderRadius: '18px',
	backgroundColor: colors.surface,
	boxShadow: shadows.md,
	color: colors.text,
	opacity: 0,
	translate: '0 -8px',
	scale: '0.98',
	transformOrigin: 'top center',
	transition: `opacity 180ms ${transitions.easeOut}, translate 180ms ${transitions.easeOut}, scale 180ms ${transitions.easeOut}, display 180ms allow-discrete, overlay 180ms allow-discrete`,
	'&:popover-open': {
		opacity: 1,
		translate: '0 0',
		scale: '1',
		'@starting-style': {
			opacity: 0,
			translate: '0 -8px',
			scale: '0.98',
		},
	},
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.4)',
		opacity: 0,
		transition: `opacity 180ms ${transitions.easeOut}, display 180ms allow-discrete, overlay 180ms allow-discrete`,
	},
	'&:popover-open::backdrop': {
		opacity: 1,
		'@starting-style': { opacity: 0 },
	},
	'@media (prefers-reduced-motion: reduce)': {
		translate: 'none',
		scale: 'none',
		transition: `opacity 120ms ${transitions.easeOut}, display 120ms allow-discrete, overlay 120ms allow-discrete`,
	},
	// Desktop never sees it; the inline nav is the menu there.
	'@media (min-width: 821px)': { display: 'none' },
}

const menuGroupCss = {
	display: 'grid',
	gap: '0.15rem',
	'& + &': {
		marginTop: '0.35rem',
		paddingTop: '0.5rem',
		borderTop: `1px solid ${colors.border}`,
	},
	'& a': {
		display: 'flex',
		alignItems: 'center',
		// Comfortable target on a phone, not a cramped text link.
		minHeight: '44px',
		padding: '0 0.85rem',
		borderRadius: '12px',
		color: colors.text,
		textDecoration: 'none',
		fontWeight: 550,
		fontSize: '1rem',
		transition: `background-color ${transitions.fast}, color ${transitions.fast}`,
	},
	'& a[aria-current="page"]': {
		color: colors.primaryText,
		backgroundColor: colors.primarySoft,
	},
	'& a:active': { backgroundColor: colors.primarySoftest },
	[hoverMq]: {
		'& a:hover': { backgroundColor: colors.primarySoftest },
	},
}

const menuLogOutCss = {
	appearance: 'none' as const,
	minHeight: '44px',
	padding: '0 0.85rem',
	borderRadius: '12px',
	border: 'none',
	background: 'transparent',
	textAlign: 'left' as const,
	font: `550 1rem/1 ${typography.fontFamilyBody}`,
	color: colors.text,
	cursor: 'pointer',
	transition: `background-color ${transitions.fast}`,
	'&:active': { backgroundColor: colors.primarySoftest },
	[hoverMq]: {
		'&:hover': { backgroundColor: colors.primarySoftest },
	},
}

const navLoginCss = {
	fontWeight: 550,
	fontSize: '0.98rem',
	color: colors.text,
	textDecoration: 'none',
	padding: '0.7rem 0.25rem',
	whiteSpace: 'nowrap' as const,
	'&:hover': { color: colors.primaryText },
}

const navUserCss = {
	...navLoginCss,
	color: colors.textMuted,
	'&:hover': { color: colors.text },
}

/**
 * Logging out has to be a form POST, but the prototype's session corner is
 * two quiet text links (`.nav-user` then `.nav-login`) — a bordered pill here
 * reads as the page's main action, which logging out is not. So: the nav-link
 * treatment, with the button chrome stripped off.
 */
const logOutButtonCss = {
	...navLoginCss,
	appearance: 'none' as const,
	border: 'none',
	background: 'transparent',
	cursor: 'pointer',
	// A button does not inherit the page font.
	font: `550 0.98rem/1 ${typography.fontFamilyBody}`,
	transition: `color ${transitions.fast}`,
}

const demoIndicatorCss = {
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.medium,
	color: colors.textMuted,
	border: `1px solid ${colors.border}`,
	borderRadius: '0.375rem',
	padding: `0 ${spacing.xs}`,
	lineHeight: 1.6,
	letterSpacing: '0.02em',
	textTransform: 'uppercase' as const,
}
