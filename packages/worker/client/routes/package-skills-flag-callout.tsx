import { type RemixNode, css } from 'remix/component'
import { buildAuthLink } from '#client/auth-links.ts'
import { mcpSkillsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import {
	getAccentCalloutCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors } from '#universal/styles/tokens.ts'

const packageSkillsDocsHref = routes.docDetail.href({
	slug: 'package-skills',
})

export function renderPackageSkillsFlagCallout(input: {
	loggedIn: boolean
	enabled: boolean
}): RemixNode {
	const loginHref = buildAuthLink(routes.login.href(), packageSkillsDocsHref)

	return (
		<aside
			data-testid="package-skills-flag-callout"
			data-flag={mcpSkillsExtensionFlagKey}
			mix={css(calloutCss)}
		>
			<p>
				{input.enabled
					? 'You are trying package skills over MCP. It is still behind a feature flag, so it may change or go away.'
					: 'Serving package skills over MCP is behind a feature flag because it may change or go away. Turn it on for your account if you want to try it.'}
			</p>
			{input.enabled ? null : input.loggedIn ? (
				<form
					method="post"
					action={routes.packageSkillsOptInPost.href()}
					mix={css(actionCss)}
				>
					<button
						type="submit"
						data-testid="package-skills-flag-opt-in"
						mix={css(getPillButtonCss({ size: 'sm' }))}
					>
						Try package skills
					</button>
				</form>
			) : (
				<p mix={css(actionCss)}>
					<a
						href={loginHref}
						data-testid="package-skills-flag-login"
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
