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

function createHelpers(input: {
	grants: Array<{
		id: string
		clientId: string
		createdAt?: number
		redirectUri?: string
	}>
	clients?: Record<
		string,
		{ clientName?: string; redirectUris?: Array<string> }
	>
	lookupThrows?: boolean
}): OAuthGrantHelpers & { revoked: Array<string> } {
	const revoked = new Array<string>()
	return {
		revoked,
		async listUserGrants(_userId, options) {
			if (options?.cursor === 'page-2') {
				return {
					items: input.grants.slice(1).map((grant) => ({
						...grant,
						scope: ['profile'],
					})),
				}
			}
			return {
				items: input.grants.slice(0, 1).map((grant) => ({
					...grant,
					scope: ['profile'],
				})),
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

test('inbound connection state pages grants and counts unique clientIds', async () => {
	const sameClient = await loadInboundMcpConnectionState(
		createHelpers({
			grants: [
				{ id: 'grant-1', clientId: 'client-a', createdAt: 1_700_000_000 },
				{ id: 'grant-2', clientId: 'client-a', createdAt: 1_700_000_100 },
			],
			clients: { 'client-a': { clientName: 'Cursor' } },
		}),
		'user-1',
	)
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

	const twoClients = await loadInboundMcpConnectionState(
		createHelpers({
			grants: [
				{
					id: 'grant-1',
					clientId: 'https://chatgpt.com/oauth/vG3/client.json',
					redirectUri: 'https://chatgpt.com/connector/oauth/vG3',
					createdAt: 1_700_000_200,
				},
				{
					id: 'grant-2',
					clientId: 'anon-claude',
					redirectUri: 'https://claude.ai/api/mcp/auth_callback',
					createdAt: 1_700_000_000,
				},
			],
			clients: {
				'https://chatgpt.com/oauth/vG3/client.json': {
					clientName: 'ChatGPT',
				},
			},
		}),
		'user-1',
	)
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
			async revokeGrant() {
				return
			},
		},
		'user-1',
	)
	expect(withoutLookup.agents[0]).toMatchObject({
		kind: null,
		label: 'opaque-c…',
	})

	const lookupFailed = await loadInboundMcpConnectionState(
		createHelpers({
			grants: [
				{
					id: 'grant-1',
					clientId: 'https://unknown.example/oauth/client.json',
				},
			],
			lookupThrows: true,
		}),
		'user-1',
	)
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
			async revokeGrant() {
				return
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
			{ id: 'grant-1', clientId: 'client-a' },
			{ id: 'grant-2', clientId: 'client-a' },
			{ id: 'grant-3', clientId: 'client-b' },
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
		revokeConnectedMcpAgent({
			helpers,
			userId: 'user-1',
			clientId: 'missing',
		}),
	).resolves.toEqual({ error: 'not_found' })
})

test('inbound connection state joins last-used and revoke forgets that stamp', async () => {
	const meter = createInMemoryUserMeterEnv()
	const userId = `user-${crypto.randomUUID()}`
	const helpers = createHelpers({
		grants: [
			{
				id: 'grant-stale',
				clientId: 'client-stale',
				createdAt: 1_710_000_000,
			},
			{
				id: 'grant-active',
				clientId: 'client-active',
				createdAt: 1_700_000_000,
			},
			{
				id: 'grant-unused',
				clientId: 'client-unused',
				createdAt: 1_720_000_000,
			},
		],
		clients: {
			'client-stale': { clientName: 'Cursor' },
			'client-active': { clientName: 'Cursor' },
			'client-unused': { clientName: 'ChatGPT' },
		},
	})
	await recordInboundMcpConnectionLastUsed({
		env: meter.env,
		userId,
		clientId: 'client-stale',
		lastUsedAt: '2026-03-10T00:00:00.000Z',
		nowMs: Date.parse('2026-03-10T00:00:00.000Z'),
	})
	await recordInboundMcpConnectionLastUsed({
		env: meter.env,
		userId,
		clientId: 'client-active',
		lastUsedAt: '2026-03-20T00:00:00.000Z',
		nowMs: Date.parse('2026-03-20T00:00:00.000Z'),
	})

	const withoutMeter = await loadInboundMcpConnectionState(helpers, userId)
	expect(withoutMeter.agents.map((agent) => agent.clientId)).toEqual([
		'client-unused',
		'client-stale',
		'client-active',
	])
	expect(withoutMeter.agents.every((agent) => agent.lastUsedAt === null)).toBe(
		true,
	)

	const withMeter = await loadInboundMcpConnectionState(helpers, userId, {
		env: meter.env,
	})
	expect(withMeter.agents.map((agent) => agent.clientId)).toEqual([
		'client-active',
		'client-stale',
		'client-unused',
	])
	expect(withMeter.agents[0]).toMatchObject({
		clientId: 'client-active',
		lastUsedAt: '2026-03-20T00:00:00.000Z',
	})
	expect(withMeter.agents[1]).toMatchObject({
		clientId: 'client-stale',
		lastUsedAt: '2026-03-10T00:00:00.000Z',
	})
	expect(withMeter.agents[2]).toMatchObject({
		clientId: 'client-unused',
		lastUsedAt: null,
	})

	await expect(
		revokeConnectedMcpAgent({
			helpers,
			userId,
			clientId: 'client-active',
			env: meter.env,
		}),
	).resolves.toEqual({ revoked: 1 })
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId,
		}),
	).toEqual(new Map([['client-stale', '2026-03-10T00:00:00.000Z']]))
})
