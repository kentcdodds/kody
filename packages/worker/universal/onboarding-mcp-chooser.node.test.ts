import { expect, test } from 'vitest'
import {
	attachOnboardingMcpPackageListings,
	formatOnboardingFeaturedMcpAddHint,
	formatOnboardingFeaturedMcpChoice,
	hasConnectedOnboardingFeaturedMcpServer,
	hasPendingOnboardingFeaturedMcpAuth,
	listDisconnectedOnboardingFeaturedMcpServers,
	listOnboardingFeaturedMcpListingIds,
	matchOnboardingFeaturedMcpServer,
	normalizeOnboardingMcpServerUrl,
	onboardingFeaturedMcpServers,
	overlayOnboardingFeaturedMcpServers,
} from './onboarding-mcp-chooser.ts'

test('featured MCP chooser ships six official OAuth servers with packages', () => {
	expect(onboardingFeaturedMcpServers.map((server) => server.id)).toEqual([
		'notion',
		'linear',
		'atlassian',
		'stripe',
		'sentry',
		'canva',
	])
	expect(onboardingFeaturedMcpServers.map((server) => server.url)).toEqual([
		'https://mcp.notion.com/mcp',
		'https://mcp.linear.app/mcp',
		'https://mcp.atlassian.com/v1/mcp/authv2',
		'https://mcp.stripe.com',
		'https://mcp.sentry.dev/mcp',
		'https://mcp.canva.com/mcp',
	])
	expect(
		onboardingFeaturedMcpServers.every(
			(server) =>
				server.packageKodyId === server.id && server.listingId.length > 0,
		),
	).toBe(true)
	expect(
		onboardingFeaturedMcpServers.some((server) => server.id === 'github'),
	).toBe(false)
	expect(
		onboardingFeaturedMcpServers.some(
			(server) =>
				server.id === 'slack' ||
				server.id === 'asana' ||
				server.id === 'figma',
		),
	).toBe(false)
	expect(listOnboardingFeaturedMcpListingIds()).toHaveLength(6)
	expect(formatOnboardingFeaturedMcpChoice()).toBe(
		'Notion, Linear, Atlassian, Stripe, Sentry, or Canva',
	)
	expect(formatOnboardingFeaturedMcpAddHint()).toContain(
		'notion (https://mcp.notion.com/mcp)',
	)
	expect(formatOnboardingFeaturedMcpAddHint()).toContain(
		'canva (https://mcp.canva.com/mcp)',
	)

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
			{ name: 'linear', url: 'https://example.test/other' },
			onboardingFeaturedMcpServers[1],
		),
	).toBe(true)

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
			kodyId: 'notion',
			name: '@kody/notion',
			description: 'Notion helpers',
			iconUrl: '/icon.png',
			tags: ['notion', 'mcp'],
		},
	])
	expect(attached[0]?.packageListing?.name).toBe('@kody/notion')
	expect(attached[1]?.packageListing).toBeNull()
})
