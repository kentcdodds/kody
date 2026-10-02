import { type RemixNode, css } from 'remix/component'
import { buildAuthLink } from '#client/auth-links.ts'
import {
	localExecuteFlagKey,
	mcpApiToolFlagKey,
} from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

const openApiDocsHref = routes.docDetail.href({
	slug: 'open-api',
})

export function renderOpenApiFlagCallout(input: {
	loggedIn: boolean
	enabled: boolean
}): RemixNode {
	const loginHref = buildAuthLink(routes.login.href(), openApiDocsHref)

	return (
		<aside
			data-testid="open-api-flag-callout"
			data-flag={`${mcpApiToolFlagKey},${localExecuteFlagKey}`}
			mix={css(calloutCss)}
		>
			<p>
				{input.enabled
					? 'You are trying Open API and local execute. They are still behind feature flags, so they may change or go away.'
					: 'Open API (MCP api tool) and local execute are behind feature flags because they may change or go away. Turn them on for your account if you want to try them.'}
			</p>
			{input.enabled ? null : input.loggedIn ? (
				<form
					method="post"
					action={routes.openApiOptInPost.href()}
					mix={css(actionCss)}
				>
					<button
						type="submit"
						data-testid="open-api-flag-opt-in"
						mix={css(getPillButtonCss({ size: 'sm' }))}
					>
						Try Open API and local execute
					</button>
				</form>
			) : (
				<p mix={css(actionCss)}>
					<a
						href={loginHref}
						data-testid="open-api-flag-login"
						mix={css(getPillButtonCss({ size: 'sm' }))}
					>
						Log in to try it
					</a>
				</p>
			)}
		</aside>
	)
}

const calloutCss = {
	...getAccentCalloutCss(),
	margin: '0 0 1.4rem',
	maxWidth: '62ch',
	'& p': {
		margin: 0,
		color: colors.text,
	},
}

const actionCss = {
	margin: '0.75rem 0 0',
}
