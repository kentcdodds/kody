import { type Handle, css } from 'remix/ui'
import {
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

export function SupportRoute(_handle: Handle) {
	return () => (
		<section mix={css(pageCss)}>
			<header mix={css(pageHeaderCss)}>
				<h1 mix={css(pageTitleCss)}>Support</h1>
				<p mix={css(pageDescriptionCss)}>
					For help with the hosted Kody service at kody.codes, email{' '}
					<a href="mailto:support@kody.codes" mix={css(mutedLinkCss)}>
						support@kody.codes
					</a>
					. Operators of other deployments use <code>support@&lt;apex&gt;</code>
					.
				</p>
			</header>

			<p mix={css({ margin: 0 })}>
				<a href="/faq" mix={css(mutedLinkCss)}>
					FAQ
				</a>
				{' · '}
				<a href="/discord" mix={css(mutedLinkCss)}>
					Discord
				</a>
				{' · '}
				<a href="/privacy" mix={css(mutedLinkCss)}>
					Privacy
				</a>
			</p>
		</section>
	)
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '42rem',
	margin: '0 auto',
}
