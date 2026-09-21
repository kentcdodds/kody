import { css, type Handle } from 'remix/ui'
import { listenToRouterNavigation } from '#client/client-router.tsx'
import { dismissOpenPopoverPanel } from '#client/site-header.tsx'
import { renderIcon } from '#universal/icon.tsx'
import { routes } from '#universal/routes.ts'
import { docHref } from '#universal/docs-nav.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	typography,
} from '#universal/styles/tokens.ts'

type EntityExplainerLink = {
	href: string
	label: string
}

export type EntityExplainerCopy = {
	id: string
	question: string
	paragraphs: Array<string>
	learnMore?: Array<EntityExplainerLink>
}

const packagesIntegrationsMcpGuide = {
	href: docHref('packages-integrations-mcp'),
	label: 'Packages, integrations, and MCP servers',
} as const satisfies EntityExplainerLink

type EntityExplainerDefinition = EntityExplainerCopy & {
	match: (pathname: string) => boolean
}

function accountSection(href: string) {
	return (pathname: string) =>
		pathname === href || pathname.startsWith(`${href}/`)
}

const entityExplainerDefinitions: Array<EntityExplainerDefinition> = [
	{
		id: 'email',
		question: 'What is email?',
		match: accountSection(routes.accountEmail.href()),
		paragraphs: [
			"Every Kody account gets a personal inbox at your username on this deployment's email domain. Inbound mail is stored so automations can react to it, and your agent can send you notify-self messages or reply to stored threads.",
		],
		learnMore: [
			{
				href: docHref('how-kody-works'),
				label: 'How Kody works',
			},
		],
	},
	{
		id: 'jobs',
		question: 'What is a job?',
		match: accountSection(routes.accountJobs.href()),
		paragraphs: [
			'A job is scheduled work that runs in the cloud on Cloudflare Workers, whether or not your computer is on. Package-owned jobs live with the saved package that declares them.',
		],
		learnMore: [
			{
				href: docHref('how-kody-works'),
				label: 'How Kody works',
			},
		],
	},
	{
		id: 'workflows',
		question: 'What is a workflow?',
		match: accountSection(routes.accountWorkflows.href()),
		paragraphs: [
			'A workflow is one-shot durable work, not a recurring schedule. Inline workflows carry their code; package workflows call a published export.',
		],
		learnMore: [
			{
				href: docHref('how-kody-works'),
				label: 'How Kody works',
			},
		],
	},
	{
		id: 'webhooks',
		question: 'What is a webhook?',
		match: accountSection(routes.accountWebhooks.href()),
		paragraphs: [
			'A webhook is an inbound HTTP endpoint a package declares. The minted URL is a credential: when a provider POSTs to it, Kody runs that package’s export.',
		],
		learnMore: [
			{
				href: docHref('triggers'),
				label: 'Jobs, workflows, and webhooks',
			},
		],
	},
	{
		id: 'secrets',
		question: 'What is a secret?',
		match: accountSection(routes.accountSecrets.href()),
		paragraphs: [
			'A secret is a credential Kody stores for you — an API key or token. Your agent references it by name; Kody substitutes the value at the network boundary and never returns it to chat.',
		],
		learnMore: [
			{
				href: docHref('account-secret-setup'),
				label: 'Secret setup guide',
			},
		],
	},
	{
		id: 'integrations',
		question: 'What is an integration?',
		match: accountSection(routes.accountIntegrations.href()),
		paragraphs: [
			'An integration is a connected service — usually OAuth — so Kody can act as you on that provider. The connection is yours: packages use it, they do not own it.',
		],
		learnMore: [
			packagesIntegrationsMcpGuide,
			{
				href: docHref('integration-bootstrap'),
				label: 'Integration bootstrap guide',
			},
		],
	},
	{
		id: 'connections',
		question: 'What is a connection?',
		match: accountSection(routes.accountConnections.href()),
		paragraphs: [
			'A connection is an AI host — Cursor, Claude, ChatGPT, Codex, a CLI — that has authorized against this Kody account over MCP. Every connected host reaches the same memories, secrets, packages, jobs, and email; Kody is the home they share, not a gateway.',
		],
		learnMore: [
			{
				href: docHref('connect-your-agent'),
				label: 'Connect your agent',
			},
			packagesIntegrationsMcpGuide,
		],
	},
	{
		id: 'mcp-servers',
		question: 'What is an MCP server?',
		match: accountSection(routes.accountMcpServers.href()),
		paragraphs: [
			'An MCP server here is a remote server Kody calls for you. Its tools become callable from your agent, the inverse of connecting your agent to Kody.',
		],
		learnMore: [packagesIntegrationsMcpGuide],
	},
	{
		id: 'memories',
		question: 'What is a memory?',
		match: accountSection(routes.accountMemories.href()),
		paragraphs: [
			'A memory is a durable fact or preference Kody keeps about you across conversations. Agents retrieve a few relevant ones per task. Do not store secrets here.',
		],
		learnMore: [
			{
				href: docHref('what-is-kody'),
				label: 'What is Kody?',
			},
		],
	},
	{
		id: 'shared',
		question: 'What is a shared package?',
		match: accountSection(routes.accountShared.href()),
		paragraphs: [
			'A shared package is an invitation from one paid Kody account to another. Guests can read source and invoke. They cannot publish, write, or create jobs, apps, webhooks, or subscriptions.',
		],
		learnMore: [
			{
				href: docHref('package-sharing'),
				label: 'Package sharing',
			},
		],
	},
	{
		id: 'waiting',
		question: 'What is waiting?',
		match: accountSection(routes.accountWaiting.href()),
		paragraphs: [
			'Waiting is the queue of things only you can clear: verify email, reconnect an MCP server, promote a locked-package publish, confirm a pending email change, or finish setup.',
		],
	},
	{
		id: 'experiments',
		question: 'What are experiments?',
		match: accountSection(routes.accountExperiments.href()),
		paragraphs: [
			'Experiments is an opt-in for early, unfinished work. It puts your account in the experiments audience. Each flag still has to be on for you, and you can opt out anytime.',
		],
	},
	{
		id: 'activity',
		question: 'What is activity?',
		match: accountSection(routes.accountActivity.href()),
		paragraphs: [
			'Activity is a short execution history for jobs, package apps, webhooks, and other runtimes: open errors with logs and triage, plus the last week of runs.',
		],
	},
	{
		id: 'usage',
		question: 'What is usage?',
		match: accountSection(routes.accountUsage.href()),
		paragraphs: [
			'Usage is how much of your plan you have consumed — stored email, job slots, workflow concurrency, and other finite entitlements. Limits are per signed-in user.',
		],
		learnMore: [
			{
				href: routes.pricing.href(),
				label: 'Plans and pricing',
			},
		],
	},
	{
		id: 'community',
		question: 'What is community?',
		match: (pathname) => pathname === routes.community.href(),
		paragraphs: [
			'Community is the public catalog of published packages on this deployment. Installing creates a fork you own.',
		],
		learnMore: [
			{
				href: docHref('what-is-kody'),
				label: 'What is Kody?',
			},
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

/** One anchor for the single explainer mounted on a page. */
const entityExplainerAnchor = '--entity-explainer'

type EntityExplainerProps = {
	copy: EntityExplainerCopy
}

/**
 * Info button beside a page title. The panel is a declarative popover so
 * the shortened copy and its links work from server HTML: light dismiss,
 * Escape, and clicks, without a scroll lock.
 */
export function EntityExplainer(handle: Handle<EntityExplainerProps>) {
	const panelId = `entity-explainer-${handle.props.copy.id}`
	listenToRouterNavigation(handle, () => {
		dismissOpenPopoverPanel(document.getElementById(panelId))
	})

	return () => {
		const copy = handle.props.copy
		const titleId = `${panelId}-title`
		return (
			<>
				<button
					type="button"
					popovertarget={panelId}
					aria-label={copy.question}
					data-entity-explainer-trigger={copy.id}
					mix={css(entityExplainerButtonCss)}
				>
					{renderIcon('information', { size: '1.35rem' })}
				</button>
				<div
					id={panelId}
					popover
					role="dialog"
					aria-labelledby={titleId}
					data-entity-explainer={copy.id}
					mix={css(entityExplainerPanelCss)}
				>
					<p id={titleId} mix={css(entityExplainerTitleCss)}>
						{copy.question}
					</p>
					{copy.paragraphs.map((paragraph) => (
						<p key={paragraph} mix={css(entityExplainerBodyCss)}>
							{paragraph}
						</p>
					))}
					{copy.learnMore?.map((link) => (
						<a
							key={link.href}
							href={link.href}
							mix={css(entityExplainerLinkCss)}
						>
							{link.label}
						</a>
					))}
				</div>
			</>
		)
	}
}

const entityExplainerButtonCss = {
	display: 'inline-flex',
	flex: 'none',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	marginInline: '-0.2rem',
	padding: 0,
	border: 'none',
	borderRadius: radius.full,
	background: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	anchorName: entityExplainerAnchor,
	[hoverMq]: {
		'&:hover': {
			color: colors.text,
			backgroundColor: colors.primarySoft,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
}

const entityExplainerPanelCss = {
	// Leave `display` unset so a closed popover keeps the UA `display: none`.
	positionAnchor: entityExplainerAnchor,
	positionArea: 'bottom span-right',
	positionTryFallbacks: 'flip-block, flip-inline',
	inset: 'auto',
	width: 'min(28rem, calc(100vw - 2.5rem))',
	maxHeight: 'min(70dvh, 24rem)',
	overflow: 'auto',
	gap: '0.7rem',
	margin: '0.45rem',
	padding: '1rem 1.1rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	background: colors.surface,
	color: colors.text,
	boxShadow: shadows.md,
	boxSizing: 'border-box' as const,
	'&:popover-open': {
		display: 'grid',
	},
}

const entityExplainerTitleCss = {
	margin: 0,
	fontWeight: typography.fontWeight.bold,
	fontSize: '1.05rem',
	letterSpacing: '-0.02em',
	lineHeight: 1.25,
}

const entityExplainerBodyCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.98rem',
	lineHeight: 1.5,
	textWrap: 'pretty' as const,
}

const entityExplainerLinkCss = {
	color: colors.primaryText,
	fontWeight: typography.fontWeight.semibold,
	fontSize: typography.fontSize.sm,
	width: 'fit-content',
	minHeight: '44px',
	display: 'inline-flex',
	alignItems: 'center',
}
