/**
 * Primary onboarding MCP chooser. Locked to official remotes that return an
 * OAuth `authUrl` against production Kody CIMD so the wizard can add them
 * and `window.open` the authorize URL. Servers that failed that spike, or
 * that require the person to register an OAuth app, stay off this list
 * (GitHub official MCP, Slack, Asana, Figma, HubSpot, and others).
 *
 * Each card already knows name + url. Connect POSTs the account MCP-servers
 * add/reconnect API with that hardcoded url and forks the official
 * `@kody/<id>-mcp` listing in the same click. Person accounts run that
 * owned copy — official `@kody/*` listings are catalog and fork source.
 * Do not convert the official API packages to MCP-first. MCP *server*
 * names stay the short official names.
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
		packageKodyId: 'notion-mcp',
		listingId: '83ef912a-377f-42ea-a8de-036dea410ac7',
	},
	{
		id: 'linear',
		name: 'linear',
		label: 'Linear',
		url: 'https://mcp.linear.app/mcp',
		description: 'List issues, create tickets, and catch up on the backlog.',
		packageKodyId: 'linear-mcp',
		listingId: 'e63c248f-18cb-489e-afe8-395c051b5cfb',
	},
	{
		id: 'atlassian',
		name: 'atlassian',
		label: 'Atlassian',
		url: 'https://mcp.atlassian.com/v1/mcp/authv2',
		description: 'Search Jira issues and Confluence pages you can already see.',
		packageKodyId: 'atlassian-mcp',
		listingId: '5db964f9-df0d-4193-81cb-e561fb869e2a',
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
	},
	{
		id: 'sentry',
		name: 'sentry',
		label: 'Sentry',
		url: 'https://mcp.sentry.dev/mcp',
		description: 'Inspect organizations, projects, and recent issues.',
		packageKodyId: 'sentry-mcp',
		listingId: '1724144b-2a25-4bcb-adf0-cba0e0f3ed6f',
	},
	{
		id: 'canva',
		name: 'canva',
		label: 'Canva',
		url: 'https://mcp.canva.com/mcp',
		description: 'Find designs, folders, and export jobs you can access.',
		packageKodyId: 'canva-mcp',
		listingId: '71b33b8a-7eae-4be1-80b9-56a7057bb466',
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
