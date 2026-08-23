/**
 * Primary onboarding MCP chooser. Locked to official remotes that return an
 * OAuth `authUrl` against production Kody CIMD so the wizard can add them
 * and `window.open` the authorize URL. Servers that failed that spike, or
 * that require the person to register an OAuth app, stay off this list
 * (GitHub official MCP, Slack, Asana, Figma, HubSpot, and others).
 *
 * Each card already knows name + url. Connect POSTs the account MCP-servers
 * add/reconnect API with that hardcoded url. Each card also pairs with the
 * official `@kody/<id>` listing so Step 2 can install the matching package.
 */

import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'

export const onboardingFeaturedMcpServerIds = [
	'notion',
	'linear',
	'atlassian',
	'stripe',
	'sentry',
	'canva',
] as const

export type OnboardingFeaturedMcpServerId =
	(typeof onboardingFeaturedMcpServerIds)[number]

export type OnboardingFeaturedMcpServerOption = {
	id: OnboardingFeaturedMcpServerId
	name: string
	label: string
	url: string
	description: string
	packageKodyId: string
	listingId: string
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
		packageKodyId: 'notion',
		listingId: '601490f4-98dd-417c-9300-75ce489f8a6d',
	},
	{
		id: 'linear',
		name: 'linear',
		label: 'Linear',
		url: 'https://mcp.linear.app/mcp',
		description: 'List issues, create tickets, and catch up on the backlog.',
		packageKodyId: 'linear',
		listingId: '41431740-2189-43f6-8db4-a9c10ed6def4',
	},
	{
		id: 'atlassian',
		name: 'atlassian',
		label: 'Atlassian',
		url: 'https://mcp.atlassian.com/v1/mcp/authv2',
		description: 'Search Jira issues and Confluence pages you can already see.',
		packageKodyId: 'atlassian',
		listingId: 'e70783f0-b879-4ba3-8562-309a1110ff7b',
	},
	{
		id: 'stripe',
		name: 'stripe',
		label: 'Stripe',
		url: 'https://mcp.stripe.com',
		description: 'Inspect customers, invoices, and recent payments you can access.',
		packageKodyId: 'stripe',
		listingId: 'e62a890e-d8df-41c1-8449-a5c093dcce02',
	},
	{
		id: 'sentry',
		name: 'sentry',
		label: 'Sentry',
		url: 'https://mcp.sentry.dev/mcp',
		description: 'Inspect organizations, projects, and recent issues.',
		packageKodyId: 'sentry',
		listingId: 'bb2ab3d0-2654-4045-9102-c20b6b0b8328',
	},
	{
		id: 'canva',
		name: 'canva',
		label: 'Canva',
		url: 'https://mcp.canva.com/mcp',
		description: 'Find designs, folders, and export jobs you can access.',
		packageKodyId: 'canva',
		listingId: 'c5c8bc47-4a26-4641-b038-789e9691fe8d',
	},
] as const satisfies ReadonlyArray<OnboardingFeaturedMcpServerOption>

export function listOnboardingFeaturedMcpListingIds(): Array<string> {
	return onboardingFeaturedMcpServers.map((server) => server.listingId)
}

/** "Notion, Linear, Atlassian, Stripe, Sentry, or Canva" */
export function formatOnboardingFeaturedMcpChoice(): string {
	const labels = onboardingFeaturedMcpServers.map((server) => server.label)
	if (labels.length === 0) return ''
	if (labels.length === 1) return labels[0] ?? ''
	if (labels.length === 2) return `${labels[0]} or ${labels[1]}`
	return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`
}

export function formatOnboardingFeaturedMcpAddHint(): string {
	return onboardingFeaturedMcpServers
		.map((server) => `${server.name} (${server.url})`)
		.join(', ')
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

export function matchOnboardingFeaturedMcpServer(
	setting: { name: string; url: string },
	option: Pick<OnboardingFeaturedMcpServerOption, 'name' | 'url'>,
): boolean {
	return (
		setting.name === option.name ||
		normalizeOnboardingMcpServerUrl(setting.url) ===
			normalizeOnboardingMcpServerUrl(option.url)
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
