import { expect, test } from 'vitest'
import {
	attachOnboardingMcpPackageListings,
	featuredOnboardingMcpFingerprint,
	formatOnboardingFeaturedMcpAddHint,
	formatOnboardingFeaturedMcpChoice,
	customOnboardingMcpFingerprint,
	hasConnectedOnboardingCustomMcpServer,
	hasConnectedOnboardingFeaturedMcpServer,
	firstConnectedOnboardingWorkspaceLabel,
	hasConnectedOnboardingWorkspaceMcp,
	hasPendingOnboardingCustomMcpAuth,
	hasPendingOnboardingFeaturedMcpAuth,
	listOnboardingCustomMcpServers,
	listDisconnectedOnboardingFeaturedMcpServers,
	listOnboardingFeaturedMcpListingIds,
	matchOnboardingFeaturedMcpServer,
	normalizeOnboardingMcpServerUrl,
	onboardingFeaturedMcpServers,
	overlayOnboardingFeaturedMcpServers,
} from './onboarding-mcp-chooser.ts'

test('featured MCP chooser overlays OAuth state and package listings', () => {
	expect(onboardingFeaturedMcpServers.length).toBeGreaterThan(0)
	expect(
		onboardingFeaturedMcpServers.every(
			(server) =>
				server.packageKodyId === `${server.id}-mcp` &&
				server.listingId.length > 0 &&
				server.url.startsWith('https://'),
		),
	).toBe(true)
	expect(listOnboardingFeaturedMcpListingIds()).toEqual(
		onboardingFeaturedMcpServers.map((server) => server.listingId),
	)
	expect(formatOnboardingFeaturedMcpChoice().length).toBeGreaterThan(0)
	expect(formatOnboardingFeaturedMcpAddHint().length).toBeGreaterThan(0)

	expect(normalizeOnboardingMcpServerUrl('https://mcp.notion.com/mcp/')).toBe(
		'https://mcp.notion.com/mcp',
	)
	expect(
		matchOnboardingFeaturedMcpServer(
			{ name: 'notes', url: 'https://mcp.notion.com/mcp/' },
			onboardingFeaturedMcpServers[0],
		),
	).toBe(true)
	expect(
		matchOnboardingFeaturedMcpServer(
			{ name: 'linear', url: 'https://mcp.linear.app/sse' },
			onboardingFeaturedMcpServers[1],
		),
	).toBe(true)
	expect(
		matchOnboardingFeaturedMcpServer(
			{ name: 'linear', url: 'https://example.test/other' },
			onboardingFeaturedMcpServers[1],
		),
	).toBe(false)

	const disconnected = listDisconnectedOnboardingFeaturedMcpServers()
	expect(disconnected).toHaveLength(6)
	expect(hasConnectedOnboardingFeaturedMcpServer(disconnected)).toBe(false)
	expect(hasPendingOnboardingFeaturedMcpAuth(disconnected)).toBe(false)
	expect(disconnected.every((server) => server.packageListing == null)).toBe(
		true,
	)

	const overlaid = overlayOnboardingFeaturedMcpServers({
		settings: [
			{
				id: 'srv-linear',
				name: 'linear',
				url: 'https://mcp.linear.app/mcp',
			},
		],
		statusByServerId: new Map([
			[
				'srv-linear',
				{
					connected: false,
					authUrl: 'https://auth.linear.test/authorize',
					state: 'authenticating',
					error: null,
				},
			],
		]),
	})
	expect(overlaid[0]?.connected).toBe(false)
	expect(overlaid[0]?.serverId).toBeNull()
	expect(overlaid[1]).toMatchObject({
		id: 'linear',
		connected: false,
		serverId: 'srv-linear',
		authUrl: 'https://auth.linear.test/authorize',
		state: 'authenticating',
	})
	expect(hasPendingOnboardingFeaturedMcpAuth(overlaid)).toBe(true)

	const connected = overlayOnboardingFeaturedMcpServers({
		settings: [
			{
				id: 'srv-notion',
				name: 'notion',
				url: 'https://mcp.notion.com/mcp',
			},
		],
		statusByServerId: new Map([
			[
				'srv-notion',
				{
					connected: true,
					authUrl: null,
					state: 'ready',
					error: null,
				},
			],
		]),
	})
	expect(hasConnectedOnboardingFeaturedMcpServer(connected)).toBe(true)
	expect(hasPendingOnboardingFeaturedMcpAuth(connected)).toBe(false)

	const attached = attachOnboardingMcpPackageListings(connected, [
		{
			id: onboardingFeaturedMcpServers[0].listingId,
			kodyId: 'notion-mcp',
			name: '@kody/notion-mcp',
			description: 'Notion MCP helpers',
			iconUrl: '/icon.png',
			tags: ['notion', 'mcp'],
		},
	])
	expect(attached[0]?.packageListing?.name).toBe('@kody/notion-mcp')
	expect(attached[1]?.packageListing).toBeNull()

	const withoutListing = listDisconnectedOnboardingFeaturedMcpServers()
	const notionListing = {
		id: onboardingFeaturedMcpServers[0].listingId,
		kodyId: 'notion-mcp',
		name: '@kody/notion-mcp',
		description: 'Notion MCP helpers',
		iconUrl: '/icon.png',
		tags: ['notion', 'mcp'],
	}
	const withListing = attachOnboardingMcpPackageListings(withoutListing, [
		notionListing,
	])
	const withInstall = attachOnboardingMcpPackageListings(withoutListing, [
		{
			...notionListing,
			viewerInstall: {
				status: 'installed',
				targetName: '@me/notion-mcp',
				agentPrompt: 'Use @me/notion-mcp',
				packageId: 'pkg-notion-mcp',
				listingAhead: false,
				listingAheadPrompt: null,
			},
		},
	])
	expect(featuredOnboardingMcpFingerprint(withoutListing)).not.toBe(
		featuredOnboardingMcpFingerprint(withListing),
	)
	expect(featuredOnboardingMcpFingerprint(withListing)).not.toBe(
		featuredOnboardingMcpFingerprint(withInstall),
	)
})

test('custom MCP servers exclude featured remotes and count as a workspace connect', () => {
	const custom = listOnboardingCustomMcpServers({
		settings: [
			{
				id: 'srv-linear',
				name: 'linear',
				url: 'https://mcp.linear.app/mcp',
			},
			{
				id: 'srv-acme',
				name: 'acme',
				url: 'https://mcp.acme.example/mcp',
			},
			{
				id: 'srv-other-linear',
				name: 'linear',
				url: 'https://mcp.other.example/mcp',
			},
		],
		statusByServerId: new Map([
			[
				'srv-acme',
				{
					connected: true,
					authUrl: null,
					state: 'ready',
					error: null,
				},
			],
		]),
	})
	expect(custom).toEqual([
		{
			id: 'srv-acme',
			name: 'acme',
			url: 'https://mcp.acme.example/mcp',
			connected: true,
			authUrl: null,
			state: 'ready',
			error: null,
		},
		{
			id: 'srv-other-linear',
			name: 'linear',
			url: 'https://mcp.other.example/mcp',
			connected: false,
			authUrl: null,
			state: null,
			error: null,
		},
	])
	expect(hasConnectedOnboardingCustomMcpServer(custom)).toBe(true)
	expect(hasPendingOnboardingCustomMcpAuth(custom)).toBe(false)
	expect(
		hasPendingOnboardingCustomMcpAuth([
			{
				id: 'srv-pending',
				name: 'acme',
				url: 'https://mcp.acme.example/mcp',
				connected: false,
				authUrl: 'https://auth.acme.example/authorize',
				state: 'authenticating',
				error: null,
			},
		]),
	).toBe(true)
	expect(
		hasConnectedOnboardingWorkspaceMcp({
			featuredMcpServers: listDisconnectedOnboardingFeaturedMcpServers(),
			customMcpServers: custom,
		}),
	).toBe(true)
	expect(
		firstConnectedOnboardingWorkspaceLabel({
			featuredMcpServers: listDisconnectedOnboardingFeaturedMcpServers(),
			customMcpServers: custom,
		}),
	).toBe('acme')
	expect(customOnboardingMcpFingerprint(custom)).toBe(
		'srv-acme:ready:1|srv-other-linear::0',
	)
	expect(
		hasConnectedOnboardingWorkspaceMcp({
			featuredMcpServers: listDisconnectedOnboardingFeaturedMcpServers(),
			customMcpServers: [],
		}),
	).toBe(false)
})
