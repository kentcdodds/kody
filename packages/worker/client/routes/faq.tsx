import { type Handle, type RemixNode, css } from 'remix/ui'
import { readCurrentRouterHref } from '#client/client-router.tsx'
import { tryConsumeRouteLoaderData } from '#client/loader-data-context.tsx'
import { type RouteLoaderResult } from '#client/route-loader.ts'
import { reveal } from '#client/reveal.ts'
import { fetchPublicAuthConfig } from '#client/social-sign-in.ts'
import { formatMinJobInterval, planLimits } from '#universal/plans.ts'
import {
	publicInviteSignupHref,
	publicSignupHref,
	publicWaitlistHref,
	publicWaitlistSignupHref,
} from '#universal/public-signup-copy.ts'
import { routes } from '#universal/routes.ts'
import { docHref } from '#universal/docs-nav.ts'
import { parseSignupMode, type SignupMode } from '#universal/signup-mode.ts'
import {
	layoutMaxWidths,
	nativeDisclosureCss,
	pageGutter,
	pageHeadCss,
} from '#universal/styles/style-primitives.ts'

type FaqItem = {
	id: string
	question: string
	answer: RemixNode
}

const count = new Intl.NumberFormat('en-US')
const freeLimits = planLimits.free
const whatIsKodyHref = docHref('what-is-kody')

const faqItems: ReadonlyArray<FaqItem> = [
	{
		id: 'replace-agents',
		question: 'Does Kody replace Claude, Cursor, ChatGPT, or Codex?',
		answer: (
			<>
				<p>
					No. Kody is not a chat app and does not replace those products. You
					connect the agent you already use — Claude, ChatGPT, Cursor, Codex, or
					any other MCP-capable host — to your Kody account.
				</p>
				<p>
					That agent gains durable capabilities that outlive the conversation:
					memory, credentials, saved code, schedules, and execution. You keep
					talking to the agent you already pay for.
				</p>
				<p>
					<a href={whatIsKodyHref}>What is Kody?</a>
				</p>
			</>
		),
	},
	{
		id: 'inference',
		question: 'Does Kody call a model / make inference calls?',
		answer: (
			<>
				<p>
					Kody does not run its own agent loop and does not bill for chat
					tokens. Your connected agent does the thinking. Kody holds the result
					so the work can run again without another model in the loop.
				</p>
				<p>
					Search indexing uses a small embedding model. That is not a chat model
					and is not billed as inference.
				</p>
			</>
		),
	},
	{
		id: 'package-prompt-memory',
		question: 'What is a package vs a prompt vs a memory?',
		answer: (
			<>
				<p>
					Kody does not treat prompts as a saved artifact. A prompt is what you
					type into your agent.
				</p>
				<p>
					A <strong>package</strong> is reusable saved code your agent writes
					and improves over time. Unlike a one-off execute, it lives in a repo
					and can expose exports, scheduled jobs, inbound webhooks, and even a
					small web app.
				</p>
				<p>
					A <strong>memory</strong> is a durable fact or preference Kody keeps
					about you. Memories follow the account across every connected agent.
					Facts saved only in a host — a Claude Project, or Cursor rules that
					are not also Kody memories — stay invisible to your other agents.
				</p>
			</>
		),
	},
	{
		id: 'shared-account',
		question: 'Can my team share one Kody account?',
		answer: (
			<>
				<p>
					No. Isolation is the feature. Each signed-in user gets a fully
					isolated assistant: their own packages, jobs, secrets, memories, and
					storage. There is no org tenancy or shared-team workspace.
				</p>
				<p>
					Your assistant is yours unless you publish a public package.
					Publishing puts a snapshot in the public catalog; installing creates a
					fork the installer owns.
				</p>
				<p>
					Trying to run Kody across a team, or have other multi-user needs?
					Email <a href="mailto:support@kody.codes">support@kody.codes</a> —
					we&rsquo;re shaping that and want to hear what you need.
				</p>
				<p>
					<a href={routes.community.href()}>Public packages</a>
				</p>
			</>
		),
	},
	{
		id: 'secrets',
		question: 'How do secrets work? Can my agent read the key?',
		answer: (
			<>
				<p>
					Your agent cannot read the key. No capability returns a secret value —
					there is deliberately no <code>secret_get</code>.
				</p>
				<p>
					Code and the agent refer to secrets by name. Kody substitutes them at
					the network boundary, only for hosts you approved. Use secrets so your
					agent can call the services you already use without pasting keys into
					the conversation.
				</p>
			</>
		),
	},
	{
		id: 'switch-agents',
		question: 'What happens if I switch agents?',
		answer: (
			<>
				<p>
					Packages, secrets, jobs, memories, and the rest of your assistant stay
					on the account. Connect the new host from{' '}
					<a href={routes.onboarding.href()}>Get started</a>. The same assistant
					is available from every MCP-capable agent you connect.
				</p>
				<p>
					Host-only context — a Claude Project, local Cursor rules, or notes
					that never became Kody memories — does not transfer.
				</p>
			</>
		),
	},
	{
		id: 'free-plan',
		question: 'What does the free plan include?',
		answer: (
			<>
				<p>
					Every plan is the whole factory. The free plan is $0 with volume caps:{' '}
					{count.format(freeLimits.maxSavedPackages)} saved packages,{' '}
					{count.format(freeLimits.maxScheduledJobs)} scheduled jobs (no faster
					than every {formatMinJobInterval(freeLimits.minJobIntervalMs)}),{' '}
					{count.format(freeLimits.maxExecuteCallsPerDay)} execute calls per
					day, and the rest of the entitlements on Pricing. Paid plans raise the
					caps.
				</p>
				<p>
					<a href={routes.pricing.href()}>Plans and pricing</a>
				</p>
			</>
		),
	},
	{
		id: 'export-self-host',
		question: 'Can I export or self-host?',
		answer: (
			<>
				<p>
					You can download a JSON export of your account from{' '}
					<a href={routes.account.href()}>Account</a> settings. Secret values
					are never included; secret entries export metadata such as names,
					hosts, and allowlists only.
				</p>
				<p>
					Kody is Fair Source. The{' '}
					<a
						href="https://github.com/kentcdodds/kody"
						target="_blank"
						rel="noreferrer noopener"
					>
						source is on GitHub
					</a>
					: you can read it, fork it, and run your own deployment.
				</p>
			</>
		),
	},
	{
		id: 'vs-other-tools',
		question:
			'How is this different from a Claude Project, a local folder of skills, or n8n?',
		answer: (
			<>
				<p>
					A Claude Project keeps context inside one host. Kody memories,
					packages, and secrets follow the account, and scheduled jobs run in
					the cloud with no model in the loop.
				</p>
				<p>
					A local folder of skills lives on one machine. Kody packages and jobs
					run on Cloudflare Workers whether or not your computer is on.
				</p>
				<p>
					n8n is a workflow builder you assemble by hand. Kody is the home your
					agents share: your agent writes the code, saves it as a package you
					own, and can schedule it so the work keeps running without another
					inference call. Installing a public package puts a fork in your
					account, on your credentials.
				</p>
			</>
		),
	},
]

function renderGetStartedAnswer(signupMode: SignupMode) {
	return (
		<>
			<p>
				Read <a href={whatIsKodyHref}>What is Kody?</a> — it needs no account.
				Then open <a href={routes.onboarding.href()}>Get started</a>, pick the
				agent you want to connect, and complete OAuth.
			</p>
			{renderGetStartedSignupGuidance(signupMode)}
		</>
	)
}

function renderGetStartedSignupGuidance(signupMode: SignupMode) {
	switch (signupMode) {
		case 'open':
			return (
				<p>
					Create a free account from <a href={publicSignupHref}>Sign up</a>.
				</p>
			)
		case 'invite':
			return (
				<p>
					Kody is invite-only. If you have a code, open{' '}
					<a href={publicSignupHref}>Sign up</a>. Without a code you can join
					the waiting list from the <a href={publicWaitlistHref}>home page</a>.
				</p>
			)
		case 'waitlist':
			return (
				<p>
					Join the waiting list from{' '}
					<a href={publicWaitlistSignupHref}>Sign up</a>. If you have a code,{' '}
					<a href={publicInviteSignupHref}>redeem it</a>.
				</p>
			)
		default: {
			const exhaustive: never = signupMode
			return exhaustive
		}
	}
}

function getFaqItems(signupMode: SignupMode): ReadonlyArray<FaqItem> {
	return [
		...faqItems,
		{
			id: 'get-started',
			question: 'How do I get started?',
			answer: renderGetStartedAnswer(signupMode),
		},
	]
}

export async function faqRouteLoader(
	_url: URL,
	signal: AbortSignal,
): Promise<RouteLoaderResult> {
	const config = await fetchPublicAuthConfig(signal)
	return { signupMode: parseSignupMode(config?.signupMode) }
}

export function FaqRoute(handle: Handle) {
	let signupMode: SignupMode = 'invite'
	return () => {
		const href = readCurrentRouterHref(handle)
		const loadedSignupMode = tryConsumeRouteLoaderData(
			handle,
			'signupMode',
			href,
		)
		if (loadedSignupMode) signupMode = loadedSignupMode
		return (
			<section mix={css(faqCss)}>
				<header mix={css(pageHeadCss)}>
					<h1 data-rise style={{ '--rise': '0' }}>
						Questions
						<br />
						before you <em>connect</em>.
					</h1>
					<p>Straight answers about what Kody is — and what it is not.</p>
				</header>

				<div mix={css(faqListCss)}>
					{getFaqItems(signupMode).map((item, index) => (
						<details
							key={item.id}
							data-faq={item.id}
							mix={[css(nativeDisclosureCss), reveal(index * 40)]}
						>
							<summary>{item.question}</summary>
							<div>{item.answer}</div>
						</details>
					))}
				</div>
			</section>
		)
	}
}

const faqCss = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(3rem, 7vw, 5.5rem) ${pageGutter} clamp(4rem, 8vw, 6.5rem)`,
}

const faqListCss = {
	width: 'min(100%, 44rem)',
	margin: 'clamp(2.5rem, 6vw, 4rem) auto 0',
	display: 'grid',
	gap: '1.25rem',
}
