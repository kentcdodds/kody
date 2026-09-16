import { type RemixNode, css } from 'remix/ui'
import { buildAuthLink } from '#client/auth-links.ts'
import { packageShareGrantsFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

const packageSharingDocsHref = routes.docDetail.href({
	slug: 'package-sharing',
})

export function renderPackageSharingFlagCallout(input: {
	loggedIn: boolean
	enabled: boolean
}): RemixNode {
	const loginHref = buildAuthLink(routes.login.href(), packageSharingDocsHref)

	return (
		<aside
			data-testid="package-sharing-flag-callout"
			data-flag={packageShareGrantsFlagKey}
			mix={css(calloutCss)}
		>
			<p>
				{input.enabled
					? 'You are trying package sharing. It is still behind a feature flag, so it may change or go away.'
					: 'Package sharing is behind a feature flag because it may change or go away. Turn it on for your account if you want to try it.'}
			</p>
			{input.enabled ? null : input.loggedIn ? (
				<form
					method="post"
					action={routes.packageSharingOptInPost.href()}
					mix={css(actionCss)}
				>
					<button
						type="submit"
						data-testid="package-sharing-flag-opt-in"
						mix={css(getPillButtonCss({ size: 'sm' }))}
					>
						Try sharing
					</button>
				</form>
			) : (
				<p mix={css(actionCss)}>
					<a
						href={loginHref}
						data-testid="package-sharing-flag-login"
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
