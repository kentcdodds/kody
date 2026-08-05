import { type Handle, css } from 'remix/ui'
import {
	colors,
	spacing,
	transitions,
	typography,
} from '#client/styles/tokens.ts'
import {
	getSecondaryButtonCss,
	layoutMaxWidths,
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

export function SiteHeader(handle: Handle<SiteHeaderProps>) {
	let scrolled = false

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
	padding: '0.8rem clamp(1.25rem, 4vw, 2.5rem)',
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

const navLinksCss = {
	display: 'flex',
	gap: '1.6rem',
	marginRight: 'auto',
	flexWrap: 'wrap' as const,
	'& a': {
		color: colors.textMuted,
		textDecoration: 'none',
		fontWeight: 500,
		fontSize: '0.98rem',
		transition: `color ${transitions.fast}`,
	},
	'& a:hover': { color: colors.text },
}

const navActionsCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '0.9rem',
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

const logOutButtonCss = {
	...getSecondaryButtonCss(),
	padding: `${spacing.xs} ${spacing.md}`,
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
