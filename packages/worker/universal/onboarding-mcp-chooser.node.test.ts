import { expect, test } from 'vitest'
import {
	hasConnectedOnboardingFeaturedMcpServer,
	hasPendingOnboardingFeaturedMcpAuth,
	listDisconnectedOnboardingFeaturedMcpServers,
	matchOnboardingFeaturedMcpServer,
	normalizeOnboardingMcpServerUrl,
	onboardingFeaturedMcpServers,
	overlayOnboardingFeaturedMcpServers,
} from './onboarding-mcp-chooser.ts'

test('featured MCP chooser is Notion and Linear only, matched by name or URL', () => {
	expect(onboardingFeaturedMcpServers.map((server) => server.id)).toEqual([
		'notion',
		'linear',
	])
	expect(onboardingFeaturedMcpServers.map((server) => server.url)).toEqual([
		'https://mcp.notion.com/mcp',
		'https://mcp.linear.app/mcp',
	])
	expect(
		onboardingFeaturedMcpServers.some((server) => server.id === 'github'),
	).toBe(false)

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
	expect(hasConnectedOnboardingFeaturedMcpServer(disconnected)).toBe(false)
	expect(hasPendingOnboardingFeaturedMcpAuth(disconnected)).toBe(false)

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
})
