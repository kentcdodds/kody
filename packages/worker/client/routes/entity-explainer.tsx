import { css, type Handle } from 'remix/ui'
import { routes } from '#universal/routes.ts'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'

export type EntityExplainerCopy = {
	id: string
	question: string
	paragraphs: Array<string>
	learnMore?: {
		href: string
		label: string
	}
}

type EntityExplainerDefinition = EntityExplainerCopy & {
	match: (pathname: string) => boolean
}

function accountSection(href: string) {
	return (pathname: string) =>
		pathname === href || pathname.startsWith(`${href}/`)
}

const entityExplainerDefinitions: Array<EntityExplainerDefinition> = [
	{
		id: 'packages',
		question: 'What is a package?',
		match: accountSection(routes.accountPackages.href()),
		paragraphs: [
			'A package is reusable saved code your agent writes and improves over time. Unlike a one-off execute, it lives in a repo with a package.json and can expose exports, scheduled jobs, inbound webhooks, and even a small web app.',
			'Use a package when work should stay invokable after the conversation ends — a daily digest, a GitHub helper, or a UI your agent hosts for you. Browse metadata here; create and edit packages through your connected agent.',
			'Trusted clients that cannot use MCP call a package over HTTP with a bearer token created on that package. The raw token is shown once and stored only as a hash.',
		],
		learnMore: {
			href: routes.guideDetail.href({ slug: 'package-lifecycle' }),
			label: 'Package lifecycle guide',
		},
	},
	{
		id: 'email',
		question: 'What is email?',
		match: accountSection(routes.accountEmail.href()),
		paragraphs: [
			"Every Kody account gets a personal inbox at your username on this deployment's email domain. Inbound mail is stored so automations can react to it, and your agent can send you notify-self messages or reply to stored threads.",
			'Use the inbox as an automation trigger — invoices to a +tag address, alerts from a job, or a daily digest that stays quiet until something actually happened. Compose and reply through your agent; this page is for browsing, classifying, and inspecting messages.',
		],
		learnMore: {
			href: routes.guideDetail.href({ slug: 'how-kody-works' }),
			label: 'How Kody works',
		},
	},
	{
		id: 'jobs',
		question: 'What is a job?',
		match: accountSection(routes.accountJobs.href()),
		paragraphs: [
			'A job is scheduled work that runs in the cloud on Cloudflare Workers, whether or not your computer is on. Ad-hoc jobs are one-off or recurring schedules that are not tied to a package; package-owned jobs live with the saved package that declares them.',
			'Use a job for anything that should happen later or on a cadence — a morning briefing, a weekly cleanup, or a catch-up run. From here you can inspect schedules, run a job now, and toggle kill switch or Preserve.',
		],
		learnMore: {
			href: routes.guideDetail.href({ slug: 'how-kody-works' }),
			label: 'How Kody works',
		},
	},
	{
		id: 'secrets',
		question: 'What is a secret?',
		match: accountSection(routes.accountSecrets.href()),
		paragraphs: [
			'A secret is a credential Kody stores for you — an API key, personal access token, or OAuth token. Your agent references secrets by name; Kody substitutes them at the network boundary and never returns the raw value to chat.',
			'Use secrets so your agent can call the services you already use without pasting keys into the conversation. Add API keys here; connect OAuth apps from Integrations.',
		],
		learnMore: {
			href: routes.guideDetail.href({ slug: 'account-secret-setup' }),
			label: 'Secret setup guide',
		},
	},
	{
		id: 'integrations',
		question: 'What is an integration?',
		match: accountSection(routes.accountIntegrations.href()),
		paragraphs: [
			"An integration is a connected service — usually OAuth — so Kody can act as you on that provider. Built-in integrations use Kody's registered app; you can also bring your own OAuth client.",
			'Use an integration when a provider needs a signed-in connection rather than a static API key. Tokens land as your secrets. Scope connections deliberately and revoke unused ones.',
		],
		learnMore: {
			href: routes.guideDetail.href({ slug: 'integration-bootstrap' }),
			label: 'Integration bootstrap guide',
		},
	},
	{
		id: 'mcp-servers',
		question: 'What is an MCP server?',
		match: accountSection(routes.accountMcpServers.href()),
		paragraphs: [
			'Kody can act as an MCP client: you add a remote MCP server, and its tools become callable as kody.mcp["server-name"].tool_name(...). This is the inverse of connecting your agent to Kody.',
			'Use this when another product already exposes MCP tools you want your Kody-connected agent to reach. Add a URL plus a bearer token, or complete OAuth when the server requires it.',
		],
	},
	{
		id: 'memories',
		question: 'What is a memory?',
		match: accountSection(routes.accountMemories.href()),
		paragraphs: [
			'A memory is a durable fact or preference Kody keeps about you across conversations — things like a preferred language or how you like to be notified. Agents retrieve a few relevant memories per task and must verify before writing.',
			'Browse, filter, and delete memories here. Ask your agent to remember something important; do not store secrets or credentials as memories.',
		],
		learnMore: {
			href: routes.guideDetail.href({ slug: 'what-is-kody' }),
			label: 'What is Kody?',
		},
	},
	{
		id: 'activity',
		question: 'What is activity?',
		match: accountSection(routes.accountActivity.href()),
		paragraphs: [
			'Activity is a short execution history for jobs, package apps, webhooks, and other runtimes. When something fails, the run, logs, and a triage state (open, ignored, or resolved) show up here.',
			'Use this page to see what broke and whether to ignore, resolve, or fix it. Your agent can review open errors through the runs capabilities. A later successful run for the same job automatically resolves earlier open errors.',
		],
	},
	{
		id: 'stars',
		question: 'What is a star?',
		match: accountSection(routes.accountStars.href()),
		paragraphs: [
			'A star is your bookmark for a community package listing. It is separate from the 1–5 rating you can leave on a listing.',
			'Star packages you want to find again, fork later, or keep an eye on. Stars are public on listings; this page is your personal list.',
		],
	},
	{
		id: 'values',
		question: 'What is a value?',
		match: accountSection(routes.accountValues.href()),
		paragraphs: [
			'Values were named readable config rows. New values are not created; existing rows stay here so you can migrate them to memories, package storage, repos, secrets, or integrations, then delete them.',
			'Open this page only during migration. Prefer memories for durable facts, package storage for package state, and secrets for credentials.',
		],
		learnMore: {
			href: routes.guideDetail.href({ slug: 'values' }),
			label: 'Values migration guide',
		},
	},
	{
		id: 'usage',
		question: 'What is usage?',
		match: accountSection(routes.accountUsage.href()),
		paragraphs: [
			'Usage is how much of your plan you have consumed — stored email, job slots, workflow concurrency, and other finite entitlements.',
			'Check this page when something is quota-gated or you are deciding whether to upgrade. Limits are per signed-in user.',
		],
		learnMore: {
			href: routes.pricing.href(),
			label: 'Plans and pricing',
		},
	},
	{
		id: 'community',
		question: 'What is community?',
		match: (pathname) => pathname === routes.community.href(),
		paragraphs: [
			"Community is the public catalog of published packages on this deployment. A listing is a pinned snapshot of someone else's package, not a live link to their private copy.",
			'Browse and search without an account. Installing creates a fork you own — you can change it, schedule it, and publish your own version. Prefer a close community package before creating one from scratch.',
		],
		learnMore: {
			href: routes.guideDetail.href({ slug: 'what-is-kody' }),
			label: 'What is Kody?',
		},
	},
	{
		id: 'timeline',
		question: 'What is the timeline?',
		match: (pathname) => pathname === routes.timeline.href(),
		paragraphs: [
			'The timeline is a feed of public community activity from accounts you follow: publishes, republishes, forks, and stars. Private package edits never appear.',
			'Follow public profiles to see what they ship. Your own public activity shows up on your profile; this page is the follow-graph view of the same events.',
		],
	},
]

export function resolveEntityExplainer(
	pathname: string,
): EntityExplainerCopy | null {
	const entry = entityExplainerDefinitions.find((item) => item.match(pathname))
	if (!entry) return null
	return {
		id: entry.id,
		question: entry.question,
		paragraphs: entry.paragraphs,
		...(entry.learnMore ? { learnMore: entry.learnMore } : {}),
	}
}

const entityExplainerCss = {
	margin: 0,
	maxWidth: '60ch',
	'& > summary': {
		cursor: 'pointer',
		fontWeight: 600,
		color: colors.primaryText,
		width: 'fit-content',
		transition: `color ${transitions.fast}`,
	},
	[hoverMq]: {
		'& > summary:hover': { color: colors.text },
	},
	'&[open] > summary': { marginBottom: '0.4rem' },
	'& > :not(summary)': {
		display: 'grid',
		gap: '0.7rem',
		color: colors.textMuted,
		fontSize: '0.98rem',
		lineHeight: 1.5,
		'@media (prefers-reduced-motion: no-preference)': {
			transition: `opacity 200ms ${transitions.easeOut}, translate 200ms ${transitions.easeOut}`,
		},
		'@starting-style': {
			opacity: 0,
			translate: '0 4px',
		},
	},
	'& p': {
		margin: 0,
		textWrap: 'pretty' as const,
	},
	'& a': {
		color: colors.primaryText,
		fontWeight: 600,
		width: 'fit-content',
		fontSize: typography.fontSize.sm,
	},
}

type EntityExplainerProps = {
	copy: EntityExplainerCopy
	marginTop?: string
}

export function EntityExplainer(handle: Handle<EntityExplainerProps>) {
	return () => (
		<details
			data-entity-explainer={handle.props.copy.id}
			mix={css({
				...entityExplainerCss,
				...(handle.props.marginTop
					? { marginTop: handle.props.marginTop }
					: {}),
			})}
		>
			<summary>{handle.props.copy.question}</summary>
			<div>
				{handle.props.copy.paragraphs.map((paragraph) => (
					<p key={paragraph}>{paragraph}</p>
				))}
				{handle.props.copy.learnMore ? (
					<p>
						<a href={handle.props.copy.learnMore.href}>
							{handle.props.copy.learnMore.label}
						</a>
					</p>
				) : null}
			</div>
		</details>
	)
}
