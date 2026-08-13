import { type Handle, css } from 'remix/ui'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

export function TermsRoute(_handle: Handle) {
	return () => (
		<section mix={css(pageCss)}>
			<header mix={css(pageHeaderCss)}>
				<h1 mix={css(pageTitleCss)}>Terms and Acceptable Use</h1>
				<p mix={css(pageDescriptionCss)}>
					The plain-spoken agreement for creating an account and using Kody.
				</p>
			</header>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Who runs Kody</h2>
				<p mix={css(descriptionCss)}>
					Kody at kody.codes is operated by Kent C. Dodds. Questions about these
					terms or the service can go to{' '}
					<a href="mailto:support@kody.codes" mix={css(mutedLinkCss)}>
						support@kody.codes
					</a>
					.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Your account</h2>
				<p mix={css(descriptionCss)}>
					You are responsible for activity under your account, including agents
					and packages you connect or run. Keep credentials and secrets private.
					Give us accurate account information, and tell us promptly if you
					think someone else has access. You may export or delete your account
					data from Account settings.
				</p>
				<p mix={css(descriptionCss)}>
					<strong>Age requirement needing confirmation:</strong> you must be at
					least [13/16 — Kent to confirm] and legally able to agree to these
					terms. If local law requires parental consent, you must have it.
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
				<h2 mix={css(cardTitleCss)}>Your agent, your access</h2>
				<p mix={css(descriptionCss)}>
					Kody is a set of primitives — code execution, packages, scheduled
					jobs, secrets, email, and integrations — that you and the AI agents
					you connect direct. Kody does not control, review, or supervise what
					your agent (or the AI models behind it) does with those primitives,
					and makes no guarantees about the instructions it will follow or the
					actions it will take.
				</p>
				<p mix={css(descriptionCss)}>
					When you connect an integration — whether a built-in one that Kody
					hosts the provider registration for, or one you register yourself — or
					store a secret, you are authorizing your agent and any code you run to
					act as you with that access. Actions taken with your tokens, keys, and
					connections are your actions: messages sent, data read, changed, or
					deleted, purchases made, and anything else your agent does on a
					third-party service. Those services also have their own terms, which
					you are responsible for honoring.
				</p>
				<p mix={css(descriptionCss)}>
					Scope access deliberately: grant only the scopes you need, review
					packages before installing them, and revoke connections you no longer
					use (from Account settings and from the provider&apos;s side). To the
					fullest extent the law permits, Kody and its operator are not liable
					for what your agent, or code you run or install, does with the access
					you grant it.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Plans, billing, and refunds</h2>
				<p mix={css(descriptionCss)}>
					The Free plan costs nothing. Paid subscriptions renew through Stripe
					at the price and interval shown when you subscribe. You can manage or
					cancel a subscription from Account settings. Plan limits are listed on
					the{' '}
					<a href="/pricing" mix={css(mutedLinkCss)}>
						Pricing
					</a>{' '}
					page.
				</p>
				<p mix={css(descriptionCss)}>
					There are no automatic refunds. If something went wrong, email{' '}
					<a href="mailto:support@kody.codes" mix={css(mutedLinkCss)}>
						support@kody.codes
					</a>
					. Refund requests are considered case by case. Taxes and payment
					processor terms may also apply.
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
					users at risk. When practical, we will explain the reason. You may
					delete your account at any time.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>The service is provided as-is</h2>
				<p mix={css(descriptionCss)}>
					Kody is provided “as is” and “as available.” To the fullest extent the
					law permits, we make no warranties, including warranties of
					merchantability, fitness for a particular purpose, non-infringement,
					or uninterrupted or error-free operation. Keep your own copies of
					anything you cannot afford to lose.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Limits on liability</h2>
				<p mix={css(descriptionCss)}>
					To the fullest extent the law permits, Kody and its operator will not
					be liable for indirect, incidental, special, consequential, exemplary,
					or punitive damages, or for lost profits, data, goodwill, or business.
					This includes damages arising from actions your agent, or code you run
					or install, takes with integrations, secrets, or other access you
					grant it — on Kody or on third-party services. Our total liability for
					any claim is limited to the amount you paid Kody during the 12 months
					before the event giving rise to the claim. These limits do not apply
					where the law does not allow them.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Governing law</h2>
				<p mix={css(descriptionCss)}>
					<strong>Kent must confirm before launch:</strong> these terms are
					governed by the laws of [STATE/COUNTRY], without regard to
					conflict-of-law rules, and disputes must be brought in the courts
					located in [COUNTY, STATE/COUNTRY], unless applicable law requires
					otherwise.
				</p>
			</section>

			<section mix={css(cardCss)}>
				<h2 mix={css(cardTitleCss)}>Privacy and changes</h2>
				<p mix={css(descriptionCss)}>
					The{' '}
					<a href="/privacy" mix={css(mutedLinkCss)}>
						Privacy
					</a>{' '}
					page explains how Kody handles data. We may update these terms by
					posting the revised terms here. We will give reasonable notice of
					material changes when practical. Continuing to use Kody after a change
					takes effect means you accept the revised terms.
				</p>
			</section>

			<p mix={css({ margin: 0 })}>
				<a href="/pricing" mix={css(mutedLinkCss)}>
					Pricing
				</a>
				{' · '}
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
