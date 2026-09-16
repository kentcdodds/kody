import { type RemixNode, css } from 'remix/ui'
import { buildAuthLink } from '#client/auth-links.ts'
import { secretProvidersFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

const secretProvidersDocsHref = routes.docDetail.href({
	slug: 'secret-providers',
})

export function renderSecretProvidersFlagCallout(input: {
	loggedIn: boolean
	enabled: boolean
}): RemixNode {
	const loginHref = buildAuthLink(routes.login.href(), secretProvidersDocsHref)

	return (
		<aside
			data-testid="secret-providers-flag-callout"
			data-flag={secretProvidersFlagKey}
			mix={css(calloutCss)}
		>
			<p>
				{input.enabled
					? 'You are trying custom secret providers. They are still behind a feature flag, so they may change or go away.'
					: 'Custom secret providers are behind a feature flag because they may change or go away. Turn them on for your account if you want to try them.'}
			</p>
			{input.enabled ? null : input.loggedIn ? (
				<form
					method="post"
					action={routes.secretProvidersOptInPost.href()}
					mix={css(actionCss)}
				>
					<button
						type="submit"
						data-testid="secret-providers-flag-opt-in"
						mix={css(getPillButtonCss({ size: 'sm' }))}
					>
						Try secret providers
					</button>
				</form>
			) : (
				<p mix={css(actionCss)}>
					<a
						href={loginHref}
						data-testid="secret-providers-flag-login"
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
