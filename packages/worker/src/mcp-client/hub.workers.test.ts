import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { mcpClientHubDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'

test('hub starts the agents lifecycle from native RPC methods', async () => {
	const userId = `hub-${crypto.randomUUID()}`
	const hub = env.MCP_CLIENT_HUB.get(
		env.MCP_CLIENT_HUB.idFromName(mcpClientHubDurableObjectName(userId)),
	)

	expect(await hub.getSnapshot()).toEqual({
		servers: [],
		connectionEvents: [],
	})
	expect(await hub.peekServers()).toEqual({ servers: [] })
	await hub.removeServer({ serverId: 'missing' })
	expect((await hub.getSnapshot()).servers).toEqual([])
})
