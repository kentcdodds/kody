import { type Handle, css } from 'remix/ui'
import {
	cardCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageEyebrowCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

export function OAuthCallbackRoute(_handle: Handle) {
	return () => {
		const params =
			typeof window === 'undefined'
				? new URLSearchParams()
				: new URLSearchParams(window.location.search)
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
					<h2 mix={css(pageTitleCss)}>OAuth callback</h2>
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
