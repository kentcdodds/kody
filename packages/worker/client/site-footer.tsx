import { type Handle, css } from 'remix/ui'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import {
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

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
	paddingBlock: '2.2rem',
	paddingInline: pageGutter,
	display: 'grid',
	gridTemplateColumns: '1fr auto 1fr',
	alignItems: 'center',
	gap: '1.2rem 2rem',
	fontSize: '0.92rem',
	color: colors.textMuted,
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
		justifyItems: 'center',
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

const footerLinkColumnMin = '7.5rem'

const footerNavCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: '0.5rem 1.4rem',
	justifySelf: 'end',
	justifyContent: 'flex-end',
	'& a': {
		color: colors.textMuted,
		textDecoration: 'none',
		whiteSpace: 'nowrap' as const,
		// Same fast color ease as the header nav — one voice for nav links.
		transition: `color ${transitions.fast}`,
	},
	'& a:hover': { color: colors.text },
	/* Stacked footer: wrap into as many columns as the inner measure holds
	   instead of one 10-row ladder or a nowrap row that clips. auto-fit with
	   min(100%, …) collapses to a single column before it overflows. */
	'@media (max-width: 720px)': {
		display: 'grid',
		width: '100%',
		gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${footerLinkColumnMin}), max-content))`,
		justifySelf: 'center',
		justifyContent: 'center',
		columnGap: '1.25rem',
		rowGap: '0.15rem',
		'& a': {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			minHeight: '40px',
			paddingInline: '0.75rem',
		},
	},
}
