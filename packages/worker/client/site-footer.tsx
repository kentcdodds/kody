import { type Handle, css } from 'remix/ui'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import { layoutMaxWidths } from '#universal/styles/style-primitives.ts'

export type SiteFooterProps = {
	loggedIn: boolean
	loginHref: string
}

/**
 * Site footer from the heykody.dev redesign: brand, the tagline voice line,
 * and footer nav. Color scheme follows the system preference.
 */
export function SiteFooter(handle: Handle<SiteFooterProps>) {
	return () => (
		<footer mix={css(footerCss)}>
			<div mix={css(footerInnerCss)}>
				<a href="/" mix={css(brandCss)}>
					<img src="/images/kody-mark.png" alt="" width={28} height={28} />
					<span>Kody</span>
				</a>
				<p mix={css(taglineCss)}>Make it portable.</p>
				<nav aria-label="Footer" mix={css(footerNavCss)}>
					<a href="/community">Community</a>
					<a href="/discord">Discord</a>
					<a href="/guides">Guides</a>
					<a href="/pricing">Pricing</a>
					<a href="/faq">FAQ</a>
					<a href="/support">Support</a>
					<a href="/blog">Blog</a>
					<a href="/privacy">Privacy</a>
					<a href="/terms">Terms</a>
					{handle.props.loggedIn ? (
						<a href="/account">Account</a>
					) : (
						<a href={handle.props.loginHref}>Log in</a>
					)}
				</nav>
			</div>
		</footer>
	)
}

const footerCss = {
	borderTop: `1px solid ${colors.border}`,
	viewTransitionName: 'site-footer',
}

const footerInnerCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: '2.2rem clamp(1.25rem, 4vw, 2.5rem)',
	display: 'grid',
	gridTemplateColumns: '1fr auto 1fr',
	alignItems: 'center',
	gap: '1.2rem 2rem',
	fontSize: '0.92rem',
	color: colors.textMuted,
	/* Stack before the inline nav would crowd the brand/tagline row — same idea
	   as the header's nav breakpoint, tuned for footer link count. */
	'@media (max-width: 960px)': {
		gridTemplateColumns: '1fr',
		justifyItems: 'center',
		textAlign: 'center',
	},
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

/* The tagline is the voice bit of the footer — display face. */
const taglineCss = {
	margin: 0,
	textAlign: 'center' as const,
	fontFamily: typography.fontFamilyDisplay,
	fontOpticalSizing: 'auto' as const,
}

const footerNavCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(6.5rem, auto))',
	gap: '0.45rem 1.4rem',
	justifyContent: 'end',
	justifySelf: 'end',
	maxWidth: '34rem',
	'& a': {
		color: colors.textMuted,
		textDecoration: 'none',
		textAlign: 'center' as const,
		// Same fast color ease as the header nav — one voice for nav links.
		transition: `color ${transitions.fast}`,
	},
	'& a:hover': { color: colors.text },
	'@media (max-width: 960px)': {
		justifySelf: 'center',
		justifyContent: 'center',
		width: 'min(100%, 28rem)',
		gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
		'& a': {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			minHeight: '40px',
		},
	},
	'@media (max-width: 480px)': {
		width: 'min(100%, 18rem)',
		gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
	},
}
