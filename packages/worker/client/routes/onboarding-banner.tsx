import { css } from 'remix/ui'
import { colors } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	primaryLinkCss,
} from '#client/styles/style-primitives.ts'
import { onboardingPath } from '#client/routes/onboarding.tsx'

/**
 * Callout shown when the signed-in user has never authorized an MCP host.
 */
export function renderOnboardingBanner() {
	return (
		<section
			aria-label="Get started with Kody"
			mix={css({
				...cardCss,
				borderColor: colors.primary,
				backgroundColor: colors.primarySoftest,
			})}
		>
			<h2 mix={css(cardTitleCss)}>Connect your AI agent</h2>
			<p mix={css(descriptionCss)}>
				Kody works through MCP. Add this deployment as an MCP server in Cursor,
				Claude, or any MCP-capable agent, complete the OAuth flow, then ask your
				agent to help you get set up.
			</p>
			<p mix={css({ margin: 0 })}>
				<a href={onboardingPath} mix={css(primaryLinkCss)}>
					Open onboarding guide
				</a>
			</p>
		</section>
	)
}
