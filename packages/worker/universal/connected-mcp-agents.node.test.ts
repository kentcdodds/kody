import { expect, test } from 'vitest'
import {
	countUniqueOAuthClientIds,
	hasSecondConnectedMcpClient,
	labelInboundMcpClient,
	oauthGrantCreatedAtIso,
	truncateClientIdLabel,
	uniqueOAuthClientIds,
} from './connected-mcp-agents.ts'

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
})

test('grant createdAt unix seconds become an ISO timestamp', () => {
	expect(oauthGrantCreatedAtIso(1_700_000_000)).toBe('2023-11-14T22:13:20.000Z')
	expect(oauthGrantCreatedAtIso(1_700_000_000_000)).toBe(
		'2023-11-14T22:13:20.000Z',
	)
	expect(oauthGrantCreatedAtIso(undefined)).toBeNull()
	expect(oauthGrantCreatedAtIso(Number.NaN)).toBeNull()
})
