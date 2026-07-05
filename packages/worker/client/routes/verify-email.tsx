import { type Handle, css } from 'remix/ui'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import {
	cardCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import { type EmailVerificationLoaderData } from '#app/loader-data.ts'

export function VerifyEmailRoute(handle: Handle) {
	return () => {
		const context = handle.context.get(AppLoaderDataProvider)
		const data =
			context.loaderData?.emailVerification ??
			({
				ok: false,
				error:
					'Open the verification link from your email to verify your account.',
			} satisfies EmailVerificationLoaderData)
		const title = data.ok ? 'Email verified' : 'Email verification'

		return (
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>{title}</h1>
					<p mix={css(pageDescriptionCss)}>
						{data.ok
							? 'Your Kody account can now send outbound email.'
							: 'We could not verify your email address.'}
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
					<a href="/account" mix={css(mutedLinkCss)}>
						Go to account
					</a>
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
