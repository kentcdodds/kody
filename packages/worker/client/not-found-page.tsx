import { type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	illustratedErrorActionsCss,
	illustratedErrorCopyCss,
	illustratedErrorHeadingCss,
	illustratedErrorImageCss,
	illustratedErrorPageCss,
} from './illustrated-error-page.ts'

export const notFoundPageHeading = "This doesn't quite connect."
export const notFoundPageImageSrc = '/images/kody-404-disappointed.png'

/**
 * Shared HTML 404. Generic misses and matched-route misses (a public
 * package URL that does not exist) used to pad and title themselves
 * differently; both now render this page.
 */
export function NotFoundPage(_handle: Handle) {
	return () => (
		<section data-testid="not-found-page" mix={css(illustratedErrorPageCss)}>
			<img
				src={notFoundPageImageSrc}
				alt="Kody looking disappointed, holding an Ethernet plug and a USB-C cable that do not match"
				width={1254}
				height={1254}
				mix={css(illustratedErrorImageCss)}
			/>
			<h1 mix={css(illustratedErrorHeadingCss)}>{notFoundPageHeading}</h1>
			<p mix={css(illustratedErrorCopyCss)}>
				That address isn't a page we have. It may have moved, never existed, or
				the package was unpublished.
			</p>
			<nav aria-label="What to try next" mix={css(illustratedErrorActionsCss)}>
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
