import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	type ConnectedMcpAgent,
	connectedAgentConnectionLabel,
	connectedAgentIconName,
	countUniqueOAuthClientIds,
	groupConnectedAgents,
	hasSecondConnectedMcpClient,
	labelInboundMcpClient,
	latestConnectedAt,
	oauthGrantCreatedAtIso,
	truncateClientIdLabel,
	uniqueOAuthClientIds,
} from './connected-mcp-agents.ts'
import { mcpClientTabs } from './onboarding-mcp-clients.ts'

const iconDirectory = join(
	dirname(fileURLToPath(import.meta.url)),
	'../public/images/icons',
)

test('unique client counting treats two grants for the same client as one', () => {
	expect(
		countUniqueOAuthClientIds([
			{ clientId: 'client-a' },
			{ clientId: 'client-a' },
		]),
	).toBe(1)
	expect(
		uniqueOAuthClientIds([
			{ clientId: 'client-a' },
			{ clientId: ' client-b ' },
			{ clientId: '' },
			{ clientId: null },
		]),
	).toEqual(['client-a', 'client-b'])
	expect(
		countUniqueOAuthClientIds([
			{ clientId: 'client-a' },
			{ clientId: 'client-b' },
		]),
	).toBe(2)
	expect(hasSecondConnectedMcpClient(1)).toBe(false)
	expect(hasSecondConnectedMcpClient(2)).toBe(true)
})

test('inbound labels prefer a known kind, then clientName, then hostname, then a truncated clientId', () => {
	expect(
		labelInboundMcpClient({
			clientId: 'https://chatgpt.com/oauth/vG3-MLZWUV83/client.json',
			clientName: 'ChatGPT',
			grantRedirectUri: 'https://chatgpt.com/connector/oauth/vG3-MLZWUV83',
		}),
	).toEqual({ kind: 'chatgpt', label: 'ChatGPT.com' })

	expect(
		labelInboundMcpClient({
			clientId: 'anon-claude',
			clientName: 'Claude',
			grantRedirectUri: 'https://claude.ai/api/mcp/auth_callback',
		}),
	).toEqual({ kind: 'claude-desktop', label: 'Claude Desktop' })

	expect(
		labelInboundMcpClient({
			clientId: 'cursor-local',
			clientName: 'Cursor',
		}),
	).toEqual({ kind: 'cursor', label: 'Cursor' })

	expect(
		labelInboundMcpClient({
			clientId: 'code-host',
			clientName: 'Claude Code',
		}),
	).toEqual({ kind: 'claude-code', label: 'Claude Code' })

	expect(
		labelInboundMcpClient({
			clientId: 'https://unknown.example/oauth/client.json',
			clientName: 'Acme Agent',
		}),
	).toEqual({ kind: null, label: 'Acme Agent' })

	expect(
		labelInboundMcpClient({
			clientId: 'https://unknown.example/oauth/client.json',
		}),
	).toEqual({ kind: null, label: 'unknown.example' })

	expect(
		labelInboundMcpClient({
			clientId: 'opaque-client-id-abcdefghijklmnopqrstuvwxyz',
		}),
	).toEqual({
		kind: null,
		label: 'opaque-c…',
	})
	expect(
		truncateClientIdLabel('opaque-client-id-abcdefghijklmnopqrstuvwxyz'),
	).toBe('opaque-c…')
	expect(
		connectedAgentConnectionLabel('https://chatgpt.com/oauth/vG3/client.json'),
	).toBe('chatgpt.com · vG3')
	expect(
		connectedAgentConnectionLabel(
			'https://chatgpt.com/oauth/vG4-MLZWUV83/client.json',
		),
	).toBe('chatgpt.com · vG4-MLZW…')
	expect(connectedAgentConnectionLabel('cursor-old')).toBe('cursor-o…')
	expect(
		connectedAgentConnectionLabel('https://chatgpt.com/oauth/vG3/client.json'),
	).not.toBe(
		connectedAgentConnectionLabel('https://chatgpt.com/oauth/vG4/client.json'),
	)
})

test('grant createdAt unix seconds become an ISO timestamp', () => {
	expect(oauthGrantCreatedAtIso(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z')
	expect(oauthGrantCreatedAtIso(1_700_000_000_000)).toBe(
		'2023-11-14T22:13:20.000Z',
	)
	expect(oauthGrantCreatedAtIso(undefined)).toBeNull()
	expect(oauthGrantCreatedAtIso(Number.NaN)).toBeNull()
})

test('known inbound kinds map to existing public icon SVGs; unknown kinds have no logo', () => {
	expect(connectedAgentIconName('chatgpt')).toBe('chatgpt')
	expect(connectedAgentIconName('claude-desktop')).toBe('claude')
	expect(connectedAgentIconName('claude-code')).toBe('claudecode')
	expect(connectedAgentIconName('codex')).toBe('codex')
	expect(connectedAgentIconName('cursor')).toBe('cursor')
	expect(connectedAgentIconName('devin')).toBe('devin')
	for (const tab of mcpClientTabs) {
		const icon = connectedAgentIconName(tab.id)
		if (tab.id === 'other') {
			expect(icon).toBeNull()
			continue
		}
		expect(icon).toEqual(expect.any(String))
		expect(existsSync(join(iconDirectory, `${icon}.svg`))).toBe(true)
	}
	expect(connectedAgentIconName(null)).toBeNull()
})

test('connected agents group by display name and sort newest-first at group and member level', () => {
	expect(latestConnectedAt([null, undefined, ''])).toBeNull()
	expect(
		latestConnectedAt([
			'2023-11-14T22:13:20.000Z',
			null,
			'2024-01-01T00:00:00.000Z',
		]),
	).toBe('2024-01-01T00:00:00.000Z')

	const olderCursor: ConnectedMcpAgent = {
		clientId: 'cursor-old',
		label: 'Cursor',
		kind: 'cursor',
		connectedAt: '2024-01-01T00:00:00.000Z',
	}
	const newerCursor: ConnectedMcpAgent = {
		clientId: 'cursor-new',
		label: 'Cursor',
		kind: 'cursor',
		connectedAt: '2024-06-01T00:00:00.000Z',
	}
	const chatgpt: ConnectedMcpAgent = {
		clientId: 'https://chatgpt.com/oauth/client.json',
		label: 'ChatGPT.com',
		kind: 'chatgpt',
		connectedAt: '2024-03-01T00:00:00.000Z',
	}
	const unknown: ConnectedMcpAgent = {
		clientId: 'opaque-client-id-abcdefghijklmnopqrstuvwxyz',
		label: 'Acme Agent',
		kind: null,
		connectedAt: '2024-05-01T00:00:00.000Z',
	}
	const undated: ConnectedMcpAgent = {
		clientId: 'undated',
		label: 'Acme Agent',
		kind: null,
		connectedAt: null,
	}

	const groups = groupConnectedAgents([
		olderCursor,
		chatgpt,
		undated,
		newerCursor,
		unknown,
	])
	expect(groups.map((group) => group.label)).toEqual([
		'Cursor',
		'Acme Agent',
		'ChatGPT.com',
	])
	expect(groups[0]).toMatchObject({
		kind: 'cursor',
		icon: 'cursor',
		connectedAt: '2024-06-01T00:00:00.000Z',
		members: [newerCursor, olderCursor],
	})
	expect(groups[1]).toMatchObject({
		kind: null,
		icon: null,
		connectedAt: '2024-05-01T00:00:00.000Z',
		members: [unknown, undated],
	})
	expect(groups[2]).toMatchObject({
		kind: 'chatgpt',
		icon: 'chatgpt',
		connectedAt: '2024-03-01T00:00:00.000Z',
		members: [chatgpt],
	})
})
