import { type Handle, css } from 'remix/ui'
import { readRouterSearch } from '#client/router-location.tsx'
import {
	cardCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

export function OAuthCallbackRoute(handle: Handle) {
	return () => {
		const params = new URLSearchParams(readRouterSearch(handle))
		const error = params.get('error')
		const description = params.get('error_description')
		const code = params.get('code')
		const state = params.get('state')
		const isError = Boolean(error || description)
		const title = isError ? 'Authorization failed' : 'Authorization completed'
		const message = description || error
		const detail = isError ? message : code

		return (
			<section mix={css(pageCss)}>
				<header mix={css(headerCss)}>
					<span mix={css(eyebrowCss)}>Kody secure connection</span>
					<h1 mix={css(pageTitleCss)}>OAuth callback</h1>
					<p mix={css(pageDescriptionCss)}>{title}.</p>
				</header>
				{detail ? <pre mix={css(detailCardCss)}>{detail}</pre> : null}
				{state ? <p mix={css(pageDescriptionCss)}>State: {state}</p> : null}
				<a href="/" mix={css(mutedLinkCss)}>
					Back home
				</a>
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '32rem',
	margin: '0 auto',
}

const headerCss = pageHeaderCss
const eyebrowCss = pageEyebrowCss
const detailCardCss = {
	...cardCss,
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
}
