import { type Handle, css } from 'remix/ui'
import { ThemeToggle } from '#client/theme-toggle.tsx'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import { layoutMaxWidths } from '#universal/styles/style-primitives.ts'

export type SiteFooterProps = {
	loggedIn: boolean
	loginHref: string
}

/**
 * Site footer from the heykody.dev redesign: brand, the tagline voice line,
 * footer nav, and the theme toggle.
 */
export function SiteFooter(handle: Handle<SiteFooterProps>) {
	return () => (
		<footer mix={css(footerCss)}>
			<div mix={css(footerInnerCss)}>
				<a href="/" mix={css(brandCss)}>
					<img
						src="/images/kody-mark.png"
						alt=""
						width={28}
						height={28}
						mix={css({ borderRadius: '50%' })}
					/>
					<span>Kody</span>
				</a>
				<p mix={css(taglineCss)}>Make it permanent.</p>
				<div mix={css(footerEndCss)}>
					<nav aria-label="Footer" mix={css(footerNavCss)}>
						<a href="/community">Community</a>
						<a href="/guides">Guides</a>
						<a href="/pricing">Pricing</a>
						<a href="/blog">Blog</a>
						{handle.props.loggedIn ? (
							<a href="/account">Account</a>
						) : (
							<a href={handle.props.loginHref}>Log in</a>
						)}
					</nav>
					<ThemeToggle />
				</div>
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

const footerEndCss = {
	display: 'flex',
	alignItems: 'center',
	gap: '1.4rem',
	justifySelf: 'end',
	'@media (max-width: 720px)': {
		justifySelf: 'center',
	},
	/* Stacked nav: the toggle moves below the link column rather than beside it,
	   which would leave it floating against a tall stack. */
	'@media (max-width: 560px)': {
		flexDirection: 'column' as const,
		gap: '1.1rem',
	},
}

const footerNavCss = {
	display: 'flex',
	gap: '1.4rem',
	'& a': {
		color: colors.textMuted,
		textDecoration: 'none',
		// Same fast color ease as the header nav — one voice for nav links.
		transition: `color ${transitions.fast}`,
	},
	'& a:hover': { color: colors.text },
	/* Stacked on phones: four links in a row sit close enough to mis-tap, and
	   the column gives each one a comfortable target without the 44px minimum
	   the header menu needs (these are the last thing on the page, not the
	   primary nav). Centred to match the rest of the stacked footer. */
	'@media (max-width: 560px)': {
		flexDirection: 'column' as const,
		alignItems: 'center',
		gap: '0.2rem',
		'& a': {
			display: 'flex',
			alignItems: 'center',
			minHeight: '40px',
			paddingInline: '0.75rem',
			color: colors.textMuted,
			textDecoration: 'none',
			transition: `color ${transitions.fast}`,
		},
	},
}
