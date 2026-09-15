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
import { type EmailVerificationLoaderData } from '#universal/loader-data.ts'

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
		const isEmailChange = data.ok && data.kind === 'email_change'
		const isEmailClaimRelease = data.ok && data.kind === 'email_claim_release'
		const isEmailDestination = data.kind === 'email_destination'
		const title = data.ok
			? isEmailChange
				? 'Email changed'
				: isEmailClaimRelease
					? 'Email released'
					: isEmailDestination
						? 'Email destination verified'
						: 'Email verified'
			: isEmailDestination
				? 'Verify email destination'
				: 'Email verification'
		const returnsToAccount =
			isEmailChange || isEmailClaimRelease || isEmailDestination
		const ctaHref = data.ctaHref
			? data.ctaHref
			: data.ok
				? returnsToAccount
					? '/account'
					: '/onboarding'
				: isEmailDestination
					? '/account/email#email-destinations'
					: '/account'
		const ctaLabel = data.ctaLabel
			? data.ctaLabel
			: data.ok
				? returnsToAccount
					? 'Go to account'
					: 'Continue to onboarding'
				: isEmailDestination
					? 'Resend from email inbox'
					: 'Go to account'

		return (
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>{title}</h1>
					<p mix={css(pageDescriptionCss)}>
						{data.ok
							? isEmailChange
								? 'Your Kody account uses this email address.'
								: isEmailClaimRelease
									? 'That former address can now be used to create a new Kody account.'
									: isEmailDestination
										? 'emailSend can use this address. Mail comes from your Kody platform inbox.'
										: 'Your Kody account can use MCP and send outbound email.'
							: isEmailDestination
								? 'We could not verify this email destination.'
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
					<div
						mix={css({
							display: 'flex',
							alignItems: 'center',
							gap: spacing.md,
							flexWrap: 'wrap',
						})}
					>
						<a
							href={ctaHref}
							mix={css(
								data.ok || isEmailDestination ? ctaButtonCss : mutedLinkCss,
							)}
						>
							{ctaLabel}
						</a>
						{ctaHref === '/account' ? null : (
							<a href="/account" mix={css(mutedLinkCss)}>
								Account
							</a>
						)}
					</div>
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
