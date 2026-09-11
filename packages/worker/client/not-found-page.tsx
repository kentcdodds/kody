import { type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'
import { colors, typography } from '#universal/styles/tokens.ts'

export const notFoundPageHeading = "This doesn't quite connect."

/**
 * Shared HTML 404. Generic misses and matched-route misses (a public
 * package URL that does not exist) used to pad and title themselves
 * differently; both now render this page.
 */
export function NotFoundPage(_handle: Handle) {
	return () => (
		<section data-testid="not-found-page" mix={css(pageCss)}>
			<img
				src="/images/kody-404-mismatch.jpg"
				alt="Kody looking sad while trying to plug two connectors that do not fit"
				width={1024}
				height={1024}
				mix={css(imageCss)}
			/>
			<h1 mix={css(headingCss)}>{notFoundPageHeading}</h1>
			<p mix={css(copyCss)}>
				That address isn't a page we have. It may have moved, never existed, or
				the package was unpublished.
			</p>
			<nav aria-label="What to try next" mix={css(actionsCss)}>
				<a href={routes.home.href()} mix={css(getPillButtonCss())}>
					Go home
				</a>
				<a href={routes.docs.href()} mix={css(getGhostButtonCss())}>
					Search the docs
				</a>
				<a href={routes.community.href()} mix={css(getGhostButtonCss())}>
					Browse packages
				</a>
			</nav>
		</section>
	)
}

const pageCss = {
	boxSizing: 'border-box' as const,
	width: '100%',
	maxWidth: layoutMaxWidths.narrow,
	marginInline: 'auto',
	padding: `clamp(2rem, 6vw, 4rem) ${pageGutter} clamp(3rem, 8vw, 5rem)`,
	display: 'grid',
	justifyItems: 'center',
	textAlign: 'center' as const,
	gap: '1rem',
}

const imageCss = {
	width: 'min(18rem, 72vw)',
	height: 'auto',
	display: 'block',
}

const headingCss = {
	margin: '0.4rem 0 0',
	font: `700 clamp(1.6rem, 4vw, 2.1rem)/1.15 ${typography.fontFamilyDisplay}`,
	letterSpacing: '-0.02em',
	color: colors.text,
	textWrap: 'balance' as const,
}

const copyCss = {
	margin: 0,
	maxWidth: '36rem',
	color: colors.textMuted,
	fontSize: '1.02rem',
	lineHeight: 1.5,
	textWrap: 'pretty' as const,
}

const actionsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	justifyContent: 'center',
	gap: '0.7rem',
	marginTop: '0.6rem',
}
