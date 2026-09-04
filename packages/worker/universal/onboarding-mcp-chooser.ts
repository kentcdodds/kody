/**
 * Step 2 MCP catalog: official remotes with a hosted MCP URL the agent can
 * add. This is not hosted / platform OAuth. Box, Slack, Asana, Figma,
 * HubSpot, and other “register your own OAuth app first” services stay off
 * this list and live under Show more as selectable prompt chips
 * (`/onboarding/step-2/:service`).
 *
 * The featured grid is a shuffled subset (SSR once, session-sticky). Overflow
 * MCP remotes join those chips. Overlay helpers still match these remotes
 * after the agent connects them. `/onboarding/step-2/not-listed` is the
 * custom-name surface (type any service; the prompt updates live). Other
 * unknown segments 302 to the step-2 index.
 */

import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import {
	randomOnboardingInt,
	shuffleOnboardingAgentIds,
	type OnboardingRandomInt,
} from '#universal/onboarding-mcp-clients.ts'

export const onboardingFeaturedMcpServerIds = [
	'notion',
	'linear',
	'atlassian',
	'stripe',
	'sentry',
	'canva',
	'workos',
	'resend',
	'airtable',
	'neon',
	'supabase',
	'square',
	'paypal',
	'intercom',
	'netlify',
	'cloudflare',
	'cloudinary',
	'github',
	'plaid',
	'monday',
	'prisma',
] as const

export type OnboardingFeaturedMcpServerId =
	(typeof onboardingFeaturedMcpServerIds)[number]

/**
 * Extra Show more chips on `/onboarding/step-2`. Each one is a real
 * `/onboarding/step-2/:service` selection that flavors the copyable prompt.
 * They are not a connect wizard and they are not hosted OAuth. Official MCP
 * remotes stay off this list.
 */
export const onboardingNotListedPromptServices = [
	{ id: 'google', label: 'Google' },
	{ id: 'slack', label: 'Slack' },
	{ id: 'discord', label: 'Discord' },
	{ id: 'spotify', label: 'Spotify' },
	{ id: 'x', label: 'x.com' },
	{ id: 'asana', label: 'Asana' },
	{ id: 'dropbox', label: 'Dropbox' },
	{ id: 'linkedin', label: 'LinkedIn' },
	{ id: 'zoom', label: 'Zoom' },
] as const

export type OnboardingNotListedPromptServiceId =
	(typeof onboardingNotListedPromptServices)[number]['id']

export const onboardingNotListedServiceId = 'not-listed' as const

export type OnboardingServiceChoice =
	| OnboardingFeaturedMcpServerId
	| OnboardingNotListedPromptServiceId
	| typeof onboardingNotListedServiceId

export function isOnboardingServiceChoice(
	value: string | null,
): value is OnboardingServiceChoice {
	if (value == null) return false
	if (value === onboardingNotListedServiceId) return true
	if (
		(onboardingFeaturedMcpServerIds as ReadonlyArray<string>).includes(value)
	) {
		return true
	}
	return onboardingNotListedPromptServices.some(
		(service) => service.id === value,
	)
}

export function onboardingServiceLabel(id: OnboardingServiceChoice): string {
	if (id === onboardingNotListedServiceId) return 'Not listed'
	const server = onboardingFeaturedMcpServers.find(
		(candidate) => candidate.id === id,
	)
	if (server) return server.label
	const byo = onboardingNotListedPromptServices.find(
		(candidate) => candidate.id === id,
	)
	return byo?.label ?? id
}

export type OnboardingFeaturedMcpServerOption = {
	id: OnboardingFeaturedMcpServerId
	name: string
	label: string
	url: string
	description: string
	packageKodyId: string
	listingId: string
	/** Official MCP is easier; a user-owned OAuth app or PAT is more powerful. */
	hasOauthPatAlternative: boolean
}

/** Featured grid slots on the step-2 index — overflow lives under Show more. */
export const onboardingFeaturedMcpSlotCount = 11

export type OnboardingServiceChooserPick = {
	featured: Array<OnboardingFeaturedMcpServerId>
	overflow: Array<OnboardingFeaturedMcpServerId>
}

export type OnboardingFeaturedMcpServer = OnboardingFeaturedMcpServerOption & {
	connected: boolean
	authUrl: string | null
	state: string | null
	serverId: string | null
	error: string | null
	packageListing: OnboardingFeaturedListing | null
}

export const onboardingFeaturedMcpServers = [
	{
		id: 'notion',
		name: 'notion',
		label: 'Notion',
		url: 'https://mcp.notion.com/mcp',
		description: 'Search pages, add notes, and update databases you share.',
		packageKodyId: 'notion-mcp',
		listingId: '83ef912a-377f-42ea-a8de-036dea410ac7',
		hasOauthPatAlternative: true,
	},
	{
		id: 'linear',
		name: 'linear',
		label: 'Linear',
		url: 'https://mcp.linear.app/mcp',
		description: 'List issues, create tickets, and catch up on the backlog.',
		packageKodyId: 'linear-mcp',
		listingId: 'e63c248f-18cb-489e-afe8-395c051b5cfb',
		hasOauthPatAlternative: true,
	},
	{
		id: 'atlassian',
		name: 'atlassian',
		label: 'Atlassian',
		url: 'https://mcp.atlassian.com/v1/mcp/authv2',
		description: 'Search Jira issues and Confluence pages you can already see.',
		packageKodyId: 'atlassian-mcp',
		listingId: '5db964f9-df0d-4193-81cb-e561fb869e2a',
		hasOauthPatAlternative: true,
	},
	{
		id: 'stripe',
		name: 'stripe',
		label: 'Stripe',
		url: 'https://mcp.stripe.com',
		description:
			'Inspect customers, invoices, and recent payments you can access.',
		packageKodyId: 'stripe-mcp',
		listingId: '8935ae40-1d30-410c-bc3e-17a782c3c33b',
		hasOauthPatAlternative: true,
	},
	{
		id: 'sentry',
		name: 'sentry',
		label: 'Sentry',
		url: 'https://mcp.sentry.dev/mcp',
		description: 'Inspect organizations, projects, and recent issues.',
		packageKodyId: 'sentry-mcp',
		listingId: '1724144b-2a25-4bcb-adf0-cba0e0f3ed6f',
		hasOauthPatAlternative: true,
	},
	{
		id: 'canva',
		name: 'canva',
		label: 'Canva',
		url: 'https://mcp.canva.com/mcp',
		description: 'Find designs, folders, and export jobs you can access.',
		packageKodyId: 'canva-mcp',
		listingId: '71b33b8a-7eae-4be1-80b9-56a7057bb466',
		hasOauthPatAlternative: false,
	},
	{
		id: 'workos',
		name: 'workos',
		label: 'WorkOS',
		url: 'https://mcp.workos.com/mcp',
		description: 'Inspect organizations, users, and auth you can access.',
		packageKodyId: 'workos-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'resend',
		name: 'resend',
		label: 'Resend',
		url: 'https://mcp.resend.com/mcp',
		description: 'Send and inspect email you can access.',
		packageKodyId: 'resend-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'airtable',
		name: 'airtable',
		label: 'Airtable',
		url: 'https://mcp.airtable.com/mcp',
		description: 'Read and update bases you can access.',
		packageKodyId: 'airtable-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'neon',
		name: 'neon',
		label: 'Neon',
		url: 'https://mcp.neon.tech/mcp',
		description: 'Inspect projects and databases you can access.',
		packageKodyId: 'neon-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'supabase',
		name: 'supabase',
		label: 'Supabase',
		url: 'https://mcp.supabase.com/mcp',
		description: 'Inspect projects, tables, and auth you can access.',
		packageKodyId: 'supabase-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'square',
		name: 'square',
		label: 'Square',
		url: 'https://mcp.squareup.com/sse',
		description: 'Inspect payments and catalog you can access.',
		packageKodyId: 'square-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'paypal',
		name: 'paypal',
		label: 'PayPal',
		url: 'https://mcp.paypal.com/sse',
		description: 'Inspect payments and transactions you can access.',
		packageKodyId: 'paypal-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'intercom',
		name: 'intercom',
		label: 'Intercom',
		url: 'https://mcp.intercom.com/sse',
		description: 'Search conversations and contacts you can access.',
		packageKodyId: 'intercom-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'netlify',
		name: 'netlify',
		label: 'Netlify',
		url: 'https://netlify-mcp.netlify.app/mcp',
		description: 'Inspect sites and deploys you can access.',
		packageKodyId: 'netlify-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'cloudflare',
		name: 'cloudflare',
		label: 'Cloudflare',
		url: 'https://bindings.mcp.cloudflare.com/mcp',
		description: 'Inspect accounts and bindings you can access.',
		packageKodyId: 'cloudflare-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'cloudinary',
		name: 'cloudinary',
		label: 'Cloudinary',
		url: 'https://asset-management.mcp.cloudinary.com/mcp',
		description: 'Find and manage assets you can access.',
		packageKodyId: 'cloudinary-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'github',
		name: 'github',
		label: 'GitHub',
		url: 'https://api.githubcopilot.com/mcp/',
		description: 'Search repos, issues, and pull requests you can access.',
		packageKodyId: 'github-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'plaid',
		name: 'plaid',
		label: 'Plaid',
		url: 'https://api.dashboard.plaid.com/mcp/sse',
		description: 'Inspect items and accounts you can access.',
		packageKodyId: 'plaid-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'monday',
		name: 'monday',
		label: 'monday.com',
		url: 'https://mcp.monday.com/sse',
		description: 'Inspect boards and items you can access.',
		packageKodyId: 'monday-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
	{
		id: 'prisma',
		name: 'prisma',
		label: 'Prisma',
		url: 'https://mcp.prisma.io/mcp',
		description: 'Inspect Prisma Postgres you can access.',
		packageKodyId: 'prisma-mcp',
		listingId: '',
		hasOauthPatAlternative: true,
	},
] as const satisfies ReadonlyArray<OnboardingFeaturedMcpServerOption>

export function listOnboardingFeaturedMcpListingIds(): Array<string> {
	return onboardingFeaturedMcpServers
		.map((server) => server.listingId)
		.filter((id) => id.length > 0)
}

/** Short setup-prompt list — the Step 2 grid is the full catalog. */
export function formatOnboardingFeaturedMcpChoice(): string {
	return 'an official MCP server such as Notion, Linear, or Stripe'
}

export function formatOnboardingFeaturedMcpAddHint(): string {
	return onboardingFeaturedMcpServers
		.filter((server) => server.listingId.length > 0)
		.map((server) => `${server.name} (${server.url})`)
		.join(', ')
}

export function onboardingFeaturedMcpServerById(
	id: string,
): OnboardingFeaturedMcpServerOption | null {
	return onboardingFeaturedMcpServers.find((server) => server.id === id) ?? null
}

/**
 * Repo icons for catalog chips that are not in `ProviderIcon`. Do not invent
 * lookalikes — missing files fall through to a letter mark.
 */
const onboardingServiceImageIconIds = [
	'airtable',
	'cloudflare',
	'cloudinary',
	'intercom',
	'monday',
	'neon',
	'netlify',
	'paypal',
	'plaid',
	'prisma',
	'resend',
	'square',
	'supabase',
	'workos',
] as const

export function onboardingServiceImageIconSrc(id: string): string | null {
	if (!(onboardingServiceImageIconIds as ReadonlyArray<string>).includes(id)) {
		return null
	}
	return `/images/icons/${id}.svg`
}

function isPermutation(
	actual: ReadonlyArray<OnboardingFeaturedMcpServerId>,
	expected: ReadonlyArray<OnboardingFeaturedMcpServerId>,
) {
	if (actual.length !== expected.length) return false
	const expectedIds = new Set(expected)
	if (new Set(actual).size !== expectedIds.size) return false
	return actual.every((id) => expectedIds.has(id))
}

export function pickOnboardingServiceChooser(
	randomInt: OnboardingRandomInt = randomOnboardingInt,
): OnboardingServiceChooserPick {
	const shuffled = shuffleOnboardingAgentIds(
		onboardingFeaturedMcpServerIds,
		randomInt,
	)
	const slotCount = Math.min(onboardingFeaturedMcpSlotCount, shuffled.length)
	return {
		featured: shuffled.slice(0, slotCount),
		overflow: shuffled.slice(slotCount),
	}
}

export function canonicalOnboardingServiceChooser(): OnboardingServiceChooserPick {
	const slotCount = Math.min(
		onboardingFeaturedMcpSlotCount,
		onboardingFeaturedMcpServerIds.length,
	)
	return {
		featured: onboardingFeaturedMcpServerIds.slice(0, slotCount),
		overflow: onboardingFeaturedMcpServerIds.slice(slotCount),
	}
}

export function isValidOnboardingServiceChooserPick(
	value: OnboardingServiceChooserPick,
): boolean {
	const slotCount = Math.min(
		onboardingFeaturedMcpSlotCount,
		onboardingFeaturedMcpServerIds.length,
	)
	if (value.featured.length !== slotCount) return false
	return isPermutation(
		[...value.featured, ...value.overflow],
		onboardingFeaturedMcpServerIds,
	)
}

export function normalizeOnboardingMcpServerUrl(url: string): string {
	try {
		const parsed = new URL(url.trim())
		parsed.hash = ''
		const normalizedPath =
			parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')
		return `${parsed.origin}${normalizedPath}`
	} catch {
		return url.trim().replace(/\/+$/, '')
	}
}

function onboardingMcpServerHostsMatch(left: string, right: string): boolean {
	try {
		return new URL(left).hostname === new URL(right).hostname
	} catch {
		return false
	}
}

export function matchOnboardingFeaturedMcpServer(
	setting: { name: string; url: string },
	option: Pick<OnboardingFeaturedMcpServerOption, 'name' | 'url'>,
): boolean {
	if (
		normalizeOnboardingMcpServerUrl(setting.url) ===
		normalizeOnboardingMcpServerUrl(option.url)
	) {
		return true
	}
	// Name alone is not enough: a custom server named "linear" with some
	// other host must stay on the custom list, not overlay the official card.
	return (
		setting.name === option.name &&
		onboardingMcpServerHostsMatch(setting.url, option.url)
	)
}

function disconnectedPackageFields() {
	return {
		connected: false,
		authUrl: null,
		state: null,
		serverId: null,
		error: null,
		packageListing: null,
	} as const
}

export function listDisconnectedOnboardingFeaturedMcpServers(): Array<OnboardingFeaturedMcpServer> {
	return onboardingFeaturedMcpServers.map((option) => ({
		...option,
		...disconnectedPackageFields(),
	}))
}

export function overlayOnboardingFeaturedMcpServers(input: {
	settings: Array<{
		id: string
		name: string
		url: string
	}>
	statusByServerId?: Map<
		string,
		{
			connected: boolean
			authUrl: string | null
			state: string
			error: string | null
		}
	>
}): Array<OnboardingFeaturedMcpServer> {
	return onboardingFeaturedMcpServers.map((option) => {
		const setting = input.settings.find((candidate) =>
			matchOnboardingFeaturedMcpServer(candidate, option),
		)
		if (!setting) {
			return {
				...option,
				...disconnectedPackageFields(),
			}
		}
		const status = input.statusByServerId?.get(setting.id)
		return {
			...option,
			connected: status?.connected ?? false,
			authUrl: status?.authUrl ?? null,
			state: status?.state ?? null,
			serverId: setting.id,
			error: status?.error ?? null,
			packageListing: null,
		}
	})
}

/**
 * Poll skip key for Step 2. Must change when a listing appears after a
 * transient miss or when viewer-install status flips. Listing id is the
 * presence signal.
 */
export function featuredOnboardingMcpFingerprint(
	servers: Array<OnboardingFeaturedMcpServer>,
): string {
	return servers
		.map((server) => {
			const listing = server.packageListing
			return [
				server.id,
				server.serverId ?? '',
				server.state ?? '',
				server.connected ? '1' : '0',
				listing?.id ?? '',
				listing?.viewerInstall?.status ?? '',
			].join(':')
		})
		.join('|')
}

export function attachOnboardingMcpPackageListings(
	servers: Array<OnboardingFeaturedMcpServer>,
	listings: Array<OnboardingFeaturedListing>,
): Array<OnboardingFeaturedMcpServer> {
	const byListingId = new Map(
		listings.map((listing) => [listing.id, listing] as const),
	)
	const byKodyId = new Map(
		listings.map((listing) => [listing.kodyId, listing] as const),
	)
	return servers.map((server) => ({
		...server,
		packageListing:
			byListingId.get(server.listingId) ??
			byKodyId.get(server.packageKodyId) ??
			null,
	}))
}

export function hasConnectedOnboardingFeaturedMcpServer(
	servers: Array<OnboardingFeaturedMcpServer>,
): boolean {
	return servers.some((server) => server.connected)
}

export function hasPendingOnboardingFeaturedMcpAuth(
	servers: Array<OnboardingFeaturedMcpServer>,
): boolean {
	return servers.some((server) => server.serverId != null && !server.connected)
}

/**
 * A remote MCP server the person added themselves — not one of the featured
 * official remotes. Same add/reconnect API as `/account/mcp-servers/new`.
 */
export type OnboardingCustomMcpServer = {
	id: string
	name: string
	url: string
	connected: boolean
	authUrl: string | null
	state: string | null
	error: string | null
}

export type OnboardingMcpChooserOverlay = {
	settings: Array<{
		id: string
		name: string
		url: string
	}>
	statusByServerId?: Map<
		string,
		{
			connected: boolean
			authUrl: string | null
			state: string
			error: string | null
		}
	>
}

export function listOnboardingCustomMcpServers(
	input: OnboardingMcpChooserOverlay,
): Array<OnboardingCustomMcpServer> {
	return input.settings
		.filter(
			(setting) =>
				!onboardingFeaturedMcpServers.some((option) =>
					matchOnboardingFeaturedMcpServer(setting, option),
				),
		)
		.map((setting) => {
			const status = input.statusByServerId?.get(setting.id)
			return {
				id: setting.id,
				name: setting.name,
				url: setting.url,
				connected: status?.connected ?? false,
				authUrl: status?.authUrl ?? null,
				state: status?.state ?? null,
				error: status?.error ?? null,
			}
		})
}

export function customOnboardingMcpFingerprint(
	servers: Array<OnboardingCustomMcpServer>,
): string {
	return servers
		.map((server) =>
			[server.id, server.state ?? '', server.connected ? '1' : '0'].join(':'),
		)
		.join('|')
}

export function hasConnectedOnboardingCustomMcpServer(
	servers: Array<OnboardingCustomMcpServer>,
): boolean {
	return servers.some((server) => server.connected)
}

export function hasPendingOnboardingCustomMcpAuth(
	servers: Array<OnboardingCustomMcpServer>,
): boolean {
	return servers.some((server) => {
		if (server.connected) return false
		if (server.authUrl != null) return true
		switch (server.state) {
			case 'authenticating':
			case 'connecting':
			case 'connected':
			case 'discovering':
				return true
			default:
				return false
		}
	})
}

export function hasConnectedOnboardingWorkspaceMcp(input: {
	featuredMcpServers: Array<OnboardingFeaturedMcpServer>
	customMcpServers: Array<OnboardingCustomMcpServer>
}): boolean {
	return (
		hasConnectedOnboardingFeaturedMcpServer(input.featuredMcpServers) ||
		hasConnectedOnboardingCustomMcpServer(input.customMcpServers)
	)
}

export function firstConnectedOnboardingWorkspaceLabel(input: {
	featuredMcpServers: Array<OnboardingFeaturedMcpServer>
	customMcpServers: Array<OnboardingCustomMcpServer>
}): string | null {
	const featured = input.featuredMcpServers.find((server) => server.connected)
	if (featured) return featured.label
	const custom = input.customMcpServers.find((server) => server.connected)
	return custom?.name ?? null
}

/**
 * A later success (popup message or connected poll) must not lose to a leftover
 * `?auth=error` from the same-tab fallback.
 */
export function resolveOnboardingMcpOAuthBanner(input: {
	connected: boolean
	returnedSuccess: boolean
	returnedError: string | null
	urlError: string | null
}): string | null {
	if (input.connected || input.returnedSuccess) return null
	return input.returnedError ?? input.urlError
}
