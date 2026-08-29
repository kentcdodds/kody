import { type Handle, css } from 'remix/ui'
import { kodyDiscordInviteUrl } from '#universal/community-links.ts'
import { type AccountBillingSuccessLoaderData } from '#universal/loader-data.ts'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import {
	routeLoaderRedirect,
	type RouteLoaderResult,
} from '#client/route-loader.ts'
import {
	cardCss,
	getGhostButtonCss,
	getPrimaryButtonCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const billingPath = '/account/billing'
const onboardingPath = '/onboarding'

export async function accountBillingSuccessRouteLoader(
	url: URL,
): Promise<RouteLoaderResult> {
	if (!url.searchParams.get('session_id')?.trim()) {
		return routeLoaderRedirect(billingPath)
	}
	return {
		accountBillingSuccess: {
			ok: true,
			needsOnboarding: true,
		},
	}
}

export function AccountBillingSuccessRoute(handle: Handle) {
	return () => {
		const href = readCurrentRouterHref(handle)
		const routeData = tryConsumeRouteLoaderData(
			handle,
			'accountBillingSuccess',
			href,
		)
		const data: AccountBillingSuccessLoaderData = routeData ?? {
			ok: true,
			needsOnboarding: true,
		}

		return (
			<section mix={css(pageCss)}>
				<header mix={css(pageHeaderCss)}>
					<h1 mix={css(pageTitleCss)}>You&rsquo;re in</h1>
					<p mix={css(pageDescriptionCss)}>
						Your paid plan is active. Same factory, more room for jobs,
						workflows, and daily volume.
					</p>
				</header>
				<div mix={css(cardCss)}>
					<p mix={css(statusCss)} role="status">
						Thanks for paying for the volume you actually use.
					</p>
					<div mix={css(ctaRowCss)}>
						<a href={kodyDiscordInviteUrl} mix={css(primaryCtaCss)}>
							Join the Kody Discord
						</a>
						{data.needsOnboarding ? (
							<a href={onboardingPath} mix={css(secondaryCtaCss)}>
								Connect your agent
							</a>
						) : null}
						<a href={billingPath} mix={css(mutedLinkCss)}>
							Manage billing
						</a>
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

const statusCss = {
	color: colors.text,
	fontSize: typography.fontSize.base,
	margin: 0,
}

const ctaRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	flexWrap: 'wrap' as const,
}

const primaryCtaCss = {
	...getPrimaryButtonCss({ size: 'lg', weight: 'semibold' }),
	display: 'inline-flex',
	textDecoration: 'none',
}

const secondaryCtaCss = {
	...getGhostButtonCss(),
	display: 'inline-flex',
	textDecoration: 'none',
}
