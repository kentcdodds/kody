import { type Handle, css } from 'remix/ui'
import { colors, spacing, typography } from '#client/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#client/styles/style-primitives.ts'

export function TermsRoute(_handle: Handle) {
	return () => (
		<section mix={css(pageCss)}>
			<header mix={css(pageHeaderCss)}>
				<h1 mix={css(pageTitleCss)}>Terms and Acceptable Use</h1>
				<p mix={css(pageDescriptionCss)}>
					Simple rules for using this Kody deployment while it is invite-gated.
				</p>
			</header>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>The service</h2>
				<p mix={css(descriptionCss)}>
					Kody is a multi-user personal assistant platform. Access may be
					invite-only. Features, plans, and limits can change as the product
					evolves. The service is provided as-is without warranties.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Your account</h2>
				<p mix={css(descriptionCss)}>
					You are responsible for activity under your account, including agents
					and packages you connect or run. Keep credentials and secrets private.
					Do not share invite codes publicly. You may export or delete your
					account data from Account settings.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Acceptable use</h2>
				<p mix={css(descriptionCss)}>Do not use Kody to:</p>
				<ul mix={css(listCss)}>
					<li>Send spam, phishing, or other abusive email</li>
					<li>
						Attack, scrape, or disrupt third-party systems without permission
					</li>
					<li>Probe or abuse other users&apos; accounts or data</li>
					<li>Circumvent plan limits, suspensions, or security controls</li>
					<li>Host or distribute malware, or violate applicable law</li>
				</ul>
				<p mix={css(descriptionCss)}>
					Outbound email, compute, and storage are shared platform resources.
					Heavy or abusive use may be rate-limited, paused, or suspended.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Content and packages</h2>
				<p mix={css(descriptionCss)}>
					You retain rights to content you create. Community listings you
					publish are visible to other users under the community rules. Hosted
					package apps run author-supplied code; review packages before
					installing or adopting them. Do not publish secrets or other
					people&apos;s private data.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Suspension and termination</h2>
				<p mix={css(descriptionCss)}>
					Operators may suspend or terminate accounts that violate these terms,
					threaten platform reputation (including email sending), or put other
					users at risk. You may delete your account at any time.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Privacy</h2>
				<p mix={css(descriptionCss)}>
					How data is stored and what operators can see is described on the{' '}
					<a href="/privacy" mix={css(mutedLinkCss)}>
						Privacy
					</a>{' '}
					page.
				</p>
			</section>

			<p mix={css({ margin: 0 })}>
				<a href="/privacy" mix={css(mutedLinkCss)}>
					Privacy
				</a>
				{' · '}
				<a href="/" mix={css(mutedLinkCss)}>
					Back home
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

const listCss = {
	margin: `${spacing.sm} 0 0`,
	paddingLeft: spacing.lg,
	color: colors.text,
	display: 'grid',
	gap: spacing.xs,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.6,
}
