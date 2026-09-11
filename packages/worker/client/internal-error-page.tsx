import { type Handle, css } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import {
	internalErrorPageCopy,
	internalErrorPageHeading,
	internalErrorPageImageAlt,
	internalErrorPageImageSrc,
} from '#universal/internal-error-page.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	illustratedErrorActionsCss,
	illustratedErrorCopyCss,
	illustratedErrorHeadingCss,
	illustratedErrorPageCss,
	illustratedErrorTallImageCss,
} from './illustrated-error-page.ts'
import { readRouterUrl } from './router-location.tsx'

/**
 * Shared HTML 500. Uncaught handler failures try to render this inside the
 * app shell (same treatment as the illustrated 404). A static document with
 * the same copy and art is the fallback when even the shell cannot render.
 */
export function InternalErrorPage(handle: Handle) {
	const retryHref = normalizeRedirectTo(readRouterUrl(handle)) ?? '/'

	return () => (
		<section
			data-testid="internal-error-page"
			mix={css(illustratedErrorPageCss)}
		>
			<img
				src={internalErrorPageImageSrc}
				alt={internalErrorPageImageAlt}
				width={1024}
				height={1536}
				mix={css(illustratedErrorTallImageCss)}
			/>
			<h1 mix={css(illustratedErrorHeadingCss)}>{internalErrorPageHeading}</h1>
			<p mix={css(illustratedErrorCopyCss)}>{internalErrorPageCopy}</p>
			<nav aria-label="What to try next" mix={css(illustratedErrorActionsCss)}>
				<a href={retryHref} mix={css(getPillButtonCss())}>
					Try again
				</a>
				<a href={routes.home.href()} mix={css(getGhostButtonCss())}>
					Go home
				</a>
			</nav>
		</section>
	)
}
