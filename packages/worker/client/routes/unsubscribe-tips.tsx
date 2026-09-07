import { type Handle, css } from 'remix/ui'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import {
	cardCss,
	getPrimaryButtonCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { type TipsUnsubscribeLoaderData } from '#universal/loader-data.ts'

export function UnsubscribeTipsRoute(handle: Handle) {
	return () => {
		const context = handle.context.get(AppLoaderDataProvider)
		const data =
			context.loaderData?.tipsUnsubscribe ??
			({
				ok: false,
				error:
					'Open the unsubscribe link from a Kody tips email to stop those messages.',
			} satisfies TipsUnsubscribeLoaderData)

		return (
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>
						{data.ok ? 'Unsubscribed from tips' : 'Unsubscribe from tips'}
					</h1>
					<p mix={css(pageDescriptionCss)}>
						{data.ok
							? 'Kody tips are the usage-state campaign nudges. Verification, billing, and error-rate mail is unchanged.'
							: 'We could not unsubscribe this address from Kody tips.'}
					</p>
				</header>
				<div mix={css(cardCss)}>
					<p
						role={data.ok ? 'status' : 'alert'}
						mix={css({
							color: data.ok ? colors.text : colors.error,
							fontSize: typography.fontSize.base,
							margin: 0,
						})}
					>
						{data.ok ? data.message : data.error}
					</p>
					{data.ok ? (
						<a href="/account" mix={css(ctaButtonCss)}>
							Go to account
						</a>
					) : (
						<a href="/account" mix={css(mutedLinkCss)}>
							Go to account
						</a>
					)}
				</div>
			</section>
		)
	}
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '36rem',
	margin: '0 auto',
	gap: spacing.lg,
}

const ctaButtonCss = {
	...getPrimaryButtonCss({ size: 'lg', weight: 'semibold' }),
	display: 'inline-flex',
	textDecoration: 'none',
}
