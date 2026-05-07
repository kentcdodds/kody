import { expect, test } from 'vitest'
import { createDefaultMcpCallerContext } from '#mcp/context.ts'
import { metaListRemoteConnectorStatusCapability } from './meta-list-remote-connector-status.ts'

function buildRemoteConnectorEnv() {
	return {
		REMOTE_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get() {
				return {
					getSnapshot() {
						return Promise.resolve({
							connectorId: 'default',
							connectorKind: 'home',
							connectedAt: '2026-05-07T00:00:00.000Z',
							lastSeenAt: '2026-05-07T00:00:01.000Z',
							tools: [{ name: 'home_status' }],
						})
					},
				}
			},
		},
	} as unknown as Env
}

test('meta_list_remote_connector_status sees the default home remote connector', async () => {
	const result = await metaListRemoteConnectorStatusCapability.handler(
		{},
		{
			env: buildRemoteConnectorEnv(),
			callerContext: createDefaultMcpCallerContext({
				baseUrl: 'https://heykody.dev',
			}),
		},
	)

	expect(result.connectors).toEqual([
		expect.objectContaining({
			connector_kind: 'home',
			connector_instance_id: 'default',
			status: 'connected',
			connected: true,
			tool_count: 1,
		}),
	])
})
