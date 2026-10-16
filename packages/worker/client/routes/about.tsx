import { type Handle, css } from 'remix/component'
import {
	descriptionCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Public about page. Facts only from existing product copy (README, privacy,
 * FAQ, support) — no invented company biography.
 */
export function AboutRoute(_handle: Handle) {
	return () => (
		<section mix={css(pageCss)}>
			<header mix={css(pageHeaderCss)}>
				<h1 mix={css(pageTitleCss)}>About Kody</h1>
				<p mix={css(pageDescriptionCss)}>
					Kody is Your agents&apos; cloud: the memory, credentials, packages,
					jobs, and apps your AI agent keeps, portable across every MCP host.
				</p>
			</header>

			<p mix={css(descriptionCss)}>
				You use Kody from the agent you already pay for — Cursor, ChatGPT,
				Claude, Codex, Copilot, Grok, or any other MCP-capable host. There is no
				separate Kody chat app. Kody does not run its own agent loop and does
				not bill for chat tokens. Your connected agent does the thinking; Kody
				holds the durable result so the work can run again without another model
				in the loop.
			</p>

			<p mix={css(descriptionCss)}>
				Accounts work for individuals and teams (organizations, teams, and
				grants). Each account holds isolated packages, jobs, credentials,
				memories, email inboxes, and durable storage. The public MCP surface is
				two tools: <code>search</code> and <code>execute</code>. Connected
				agents also reach the same account over the HTTP Open API at
				api.kody.codes when you mint a scoped token.
			</p>

			<p mix={css(descriptionCss)}>
				Kent C. Dodds operates the hosted service at kody.codes and is the data
				controller for that deployment. The project is open on{' '}
				<a
					href="https://github.com/kentcdodds/kody"
					mix={css(mutedLinkCss)}
					target="_blank"
					rel="noreferrer noopener"
				>
					GitHub
				</a>
				. A free plan is available with no card required to start; plan caps and
				paid options are on{' '}
				<a href="/pricing" mix={css(mutedLinkCss)}>
					Pricing
				</a>
				. Privacy, retention, and subprocessors are described on{' '}
				<a href="/privacy" mix={css(mutedLinkCss)}>
					Privacy
				</a>
				.
			</p>

			<p mix={css(descriptionCss)}>
				Want the capability tour before connecting? Read{' '}
				<a href="/docs/what-is-kody" mix={css(mutedLinkCss)}>
					What is Kody?
				</a>{' '}
				or the compact index at{' '}
				<a href="/llms.txt" mix={css(mutedLinkCss)}>
					/llms.txt
				</a>
				. Questions and support channels are listed on{' '}
				<a href="/contact" mix={css(mutedLinkCss)}>
					Contact
				</a>
				.
			</p>
		</section>
	)
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '42rem',
	margin: '0 auto',
}
