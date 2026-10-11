import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { mcpClientHubDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { mcpClientHubTransferStub } from './hub-transfer.ts'
import { mcpOAuthRefreshTokenStorageKey } from './oauth-token-recovery.ts'

function hubFor(userId: ReturnType<typeof ownerIdFromStored>) {
	return env.MCP_CLIENT_HUB.get(
		env.MCP_CLIENT_HUB.idFromName(mcpClientHubDurableObjectName(userId)),
	)
}

test('a server moves between hubs with its stored OAuth state', async () => {
	const fromUserId = ownerIdFromStored(`hub-from-${crypto.randomUUID()}`)
	const toUserId = ownerIdFromStored(`hub-to-${crypto.randomUUID()}`)
	const serverId = 'transfer-server'
	const tokenKey = `/Kody/${serverId}/client-1/token`
	// Seed an authorization still pending (auth_url set) so the import does not
	// dial a real MCP server.
	await hubFor(fromUserId).getSnapshot()
	await runInDurableObject(hubFor(fromUserId), async (_instance, state) => {
		state.storage.sql.exec(
			`INSERT INTO cf_agents_mcp_servers
				(id, name, server_url, callback_url, client_id, auth_url, server_options)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			serverId,
			'Transfer Server',
			'https://mcp.example.com/mcp',
			'https://kody.example.com/mcp-oauth/callback',
			'client-1',
			'https://auth.example.com/authorize',
			JSON.stringify({ transport: { type: 'streamable-http' } }),
		)
		await state.storage.put({
			[tokenKey]: { access_token: 'tok', token_type: 'Bearer' },
			[mcpOAuthRefreshTokenStorageKey(serverId)]: { refresh_token: 'r' },
			'/Kody/other-server/client-2/token': { access_token: 'other' },
		})
	})

	const from = mcpClientHubTransferStub({ env, userId: fromUserId })
	const to = mcpClientHubTransferStub({ env, userId: toUserId })
	const exported = await from.exportServerForTransfer({ serverId })
	expect(exported?.row.id).toBe(serverId)
	expect(exported?.entries.map(([key]) => key).sort()).toEqual(
		[tokenKey, mcpOAuthRefreshTokenStorageKey(serverId)].sort(),
	)

	const imported = await to.importServerForTransfer(exported!)
	expect(imported).toMatchObject({
		ok: true,
		connection: { serverId, state: 'authenticating' },
	})
	await runInDurableObject(hubFor(toUserId), async (_instance, state) => {
		expect(await state.storage.get(tokenKey)).toEqual({
			access_token: 'tok',
			token_type: 'Bearer',
		})
		expect(
			state.storage.sql
				.exec('SELECT id, client_id FROM cf_agents_mcp_servers')
				.toArray(),
		).toEqual([{ id: serverId, client_id: 'client-1' }])
	})

	expect(await to.importServerForTransfer(exported!)).toEqual({
		ok: false,
		reason: 'already_registered',
	})
	const third = mcpClientHubTransferStub({
		env,
		userId: ownerIdFromStored(`hub-third-${crypto.randomUUID()}`),
	})
	expect(
		await third.importServerForTransfer({
			...exported!,
			entries: [['/Kody/other-server/client-2/token', {}]],
		}),
	).toEqual({ ok: false, reason: 'foreign_storage_key' })

	await from.removeServer({ serverId })
	expect(await from.exportServerForTransfer({ serverId })).toBeNull()
})
