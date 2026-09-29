import { expect, test } from 'vitest'
import {
	loadInboundMcpConnectionState,
	revokeConnectedMcpAgent,
} from '#worker/connected-mcp-agents.ts'
import {
	listInboundMcpConnectionLastUsed,
	recordInboundMcpConnectionLastUsed,
} from '#worker/inbound-mcp-connection-last-used.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'

type TestGrant = {
	id: string
	clientId: string
	createdAt?: number
	redirectUri?: string
}

const chatgptClientId = 'https://chatgpt.com/oauth/vG3/client.json'
const chatgptRedirect = 'https://chatgpt.com/connector/oauth/vG3'
const claudeRedirect = 'https://claude.ai/api/mcp/auth_callback'

function grant(
	id: string,
	clientId: string,
	createdAt?: number,
	redirectUri?: string,
): TestGrant {
	return { id, clientId, createdAt, redirectUri }
}

function createHelpers(input: {
	grants: Array<TestGrant>
	clients?: Record<
		string,
		{ clientName?: string; redirectUris?: Array<string> }
	>
	lookupThrows?: boolean
}): OAuthGrantHelpers & { revoked: Array<string> } {
	const revoked = new Array<string>()
	const withScope = (grants: Array<TestGrant>) =>
		grants.map((item) => ({ ...item, scope: ['profile'] }))
	return {
		revoked,
		async listUserGrants(_userId, options) {
			if (options?.cursor === 'page-2') {
				return { items: withScope(input.grants.slice(1)) }
			}
			return {
				items: withScope(input.grants.slice(0, 1)),
				...(input.grants.length > 1 ? { cursor: 'page-2' } : {}),
			}
		},
		async revokeGrant(grantId) {
			revoked.push(grantId)
		},
		async lookupClient(clientId) {
			if (input.lookupThrows) throw new Error('cimd lookup failed')
			const client = input.clients?.[clientId]
			if (!client) return null
			return { clientId, ...client }
		},
	}
}

function loadState(input: Parameters<typeof createHelpers>[0]) {
	return loadInboundMcpConnectionState(createHelpers(input), 'user-1')
}

test('inbound connection state pages grants and counts unique clientIds', async () => {
	const sameClient = await loadState({
		grants: [
			grant('grant-1', 'client-a', 1_700_000_000),
			grant('grant-2', 'client-a', 1_700_000_100),
		],
		clients: { 'client-a': { clientName: 'Cursor' } },
	})
	expect(sameClient.uniqueClientCount).toBe(1)
	expect(sameClient.agents).toEqual([
		{
			clientId: 'client-a',
			grantIds: ['grant-1', 'grant-2'],
			label: 'Cursor',
			kind: 'cursor',
			connectedAt: '2023-11-14T22:13:20.000Z',
			lastUsedAt: null,
		},
	])

	const twoClients = await loadState({
		grants: [
			grant('grant-1', chatgptClientId, 1_700_000_200, chatgptRedirect),
			grant('grant-2', 'anon-claude', 1_700_000_000, claudeRedirect),
		],
		clients: { [chatgptClientId]: { clientName: 'ChatGPT' } },
	})
	expect(twoClients.uniqueClientCount).toBe(2)
	expect(twoClients.agents.map((agent) => agent.label)).toEqual([
		'ChatGPT.com',
		'Claude Desktop',
	])
	expect(twoClients.agents[1]).toMatchObject({
		clientId: 'anon-claude',
		kind: 'claude-desktop',
		connectedAt: '2023-11-14T22:13:20.000Z',
	})
})

test('a ChatGPT grant never marks Claude connected, including a phone callback with no client name', async () => {
	const chatgpt = await loadState({
		grants: [
			grant('grant-chatgpt', chatgptClientId, 1_700_000_200, chatgptRedirect),
		],
		clients: {
			[chatgptClientId]: {
				clientName: 'ChatGPT',
				redirectUris: [chatgptRedirect],
			},
		},
	})
	expect(chatgpt.uniqueClientCount).toBe(1)
	expect(chatgpt.agents.map((agent) => agent.kind)).toEqual(['chatgpt'])
	expect(chatgpt.agents[0]).toMatchObject({ label: 'ChatGPT.com' })

	const phoneWithoutName = await loadState({
		grants: [
			grant(
				'grant-phone',
				'https://chatgpt.com/oauth/claude-model/client.json',
				1_700_000_300,
				'https://chatgpt.com/backend-api/aip/connectors/callback',
			),
		],
	})
	expect(phoneWithoutName.agents.map((agent) => agent.kind)).toEqual([
		'chatgpt',
	])

	const nameBeatsAClaudeRedirect = await loadState({
		grants: [
			grant(
				'grant-mixed',
				'opaque-chatgpt-client',
				1_700_000_400,
				claudeRedirect,
			),
		],
		clients: {
			'opaque-chatgpt-client': {
				clientName: 'ChatGPT',
				redirectUris: [claudeRedirect],
			},
		},
	})
	expect(nameBeatsAClaudeRedirect.agents.map((agent) => agent.kind)).toEqual([
		'chatgpt',
	])
})

test('inbound labels fall back when lookupClient is missing or throws', async () => {
	const withoutLookup = await loadInboundMcpConnectionState(
		{
			async listUserGrants() {
				return {
					items: [
						{
							id: 'grant-1',
							clientId: 'opaque-client-id-abcdefghijklmnopqrstuvwxyz',
							scope: ['profile'],
						},
					],
				}
			},
		},
		'user-1',
	)
	expect(withoutLookup.agents[0]).toMatchObject({
		kind: null,
		label: 'opaque-c…',
	})

	const lookupFailed = await loadState({
		grants: [grant('grant-1', 'https://unknown.example/oauth/client.json')],
		lookupThrows: true,
	})
	expect(lookupFailed.agents[0]).toMatchObject({
		kind: null,
		label: 'unknown.example',
	})

	expect(await loadInboundMcpConnectionState(undefined, 'user-1')).toEqual({
		uniqueClientCount: 0,
		agents: [],
	})

	const listingFailed = await loadInboundMcpConnectionState(
		{
			async listUserGrants() {
				throw new Error('provider unavailable')
			},
		},
		'user-1',
	)
	expect(listingFailed).toEqual({
		uniqueClientCount: 0,
		agents: [],
		listingFailed: true,
	})
})

test('revokeConnectedMcpAgent revokes every grant for that clientId', async () => {
	const helpers = createHelpers({
		grants: [
			grant('grant-1', 'client-a'),
			grant('grant-2', 'client-a'),
			grant('grant-3', 'client-b'),
		],
	})
	await expect(
		revokeConnectedMcpAgent({
			helpers,
			userId: 'user-1',
			clientId: 'client-a',
		}),
	).resolves.toEqual({ revoked: 2 })
	expect(helpers.revoked).toEqual(['grant-1', 'grant-2'])
	await expect(
		revokeConnectedMcpAgent({ helpers, userId: 'user-1', clientId: 'missing' }),
	).resolves.toEqual({ error: 'not_found' })
})

test('inbound connection state joins last-used and revoke forgets that stamp', async () => {
	const meter = createInMemoryUserMeterEnv()
	const userId = `user-${crypto.randomUUID()}`
	const helpers = createHelpers({
		grants: [
			grant('grant-stale', 'client-stale', 1_710_000_000),
			grant('grant-active', 'client-active', 1_700_000_000),
			grant('grant-unused', 'client-unused', 1_720_000_000),
		],
		clients: {
			'client-stale': { clientName: 'Cursor' },
			'client-active': { clientName: 'Cursor' },
			'client-unused': { clientName: 'ChatGPT' },
		},
	})
	for (const [clientId, lastUsedAt] of [
		['client-stale', '2026-03-10T00:00:00.000Z'],
		['client-active', '2026-03-20T00:00:00.000Z'],
	] as const) {
		await recordInboundMcpConnectionLastUsed({
			env: meter.env,
			userId,
			clientId,
			lastUsedAt,
			nowMs: Date.parse(lastUsedAt),
		})
	}
	const lastUsedByClient = (
		state: Awaited<ReturnType<typeof loadInboundMcpConnectionState>>,
	) => state.agents.map((agent) => [agent.clientId, agent.lastUsedAt])

	expect(
		lastUsedByClient(await loadInboundMcpConnectionState(helpers, userId)),
	).toEqual([
		['client-unused', null],
		['client-stale', null],
		['client-active', null],
	])
	expect(
		lastUsedByClient(
			await loadInboundMcpConnectionState(helpers, userId, { env: meter.env }),
		),
	).toEqual([
		['client-active', '2026-03-20T00:00:00.000Z'],
		['client-stale', '2026-03-10T00:00:00.000Z'],
		['client-unused', null],
	])

	await expect(
		revokeConnectedMcpAgent({
			helpers,
			userId,
			clientId: 'client-active',
			env: meter.env,
		}),
	).resolves.toEqual({ revoked: 1 })
	expect(
		await listInboundMcpConnectionLastUsed({ env: meter.env, userId }),
	).toEqual(new Map([['client-stale', '2026-03-10T00:00:00.000Z']]))
})
