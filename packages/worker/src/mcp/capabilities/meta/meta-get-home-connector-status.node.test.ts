import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { metaGetHomeConnectorStatusCapability } from './meta-get-home-connector-status.ts'

test('meta_get_home_connector_status reports a connected connector', async () => {
	const result = await metaGetHomeConnectorStatusCapability.handler(
		{},
		{
			env: {
				HOME_CONNECTOR_SESSION: {
					idFromName(name: string) {
						return name
					},
					get() {
						return {
							getSnapshot() {
								return Promise.resolve({
									connectorId: 'default',
									connectedAt: '2026-03-25T00:00:00.000Z',
									lastSeenAt: '2026-03-25T00:00:01.000Z',
									tools: [{ name: 'roku_press_key' }],
								})
							},
						}
					},
				},
			} as unknown as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				homeConnectorId: 'default',
			}),
		},
	)

	expect(result).toMatchObject({
		status: 'connected',
		connected: true,
		connector_id: 'default',
		connected_at: '2026-03-25T00:00:00.000Z',
		last_seen_at: '2026-03-25T00:00:01.000Z',
		tool_count: 1,
		error: null,
	})
	expect(result.message).toContain('default')
	expect(result.message).toContain('1 tool')
})

test('meta_get_home_connector_status reports a disconnected connector', async () => {
	const result = await metaGetHomeConnectorStatusCapability.handler(
		{},
		{
			env: {
				HOME_CONNECTOR_SESSION: {
					idFromName(name: string) {
						return name
					},
					get() {
						return {
							getSnapshot() {
								return Promise.resolve(null)
							},
						}
					},
				},
			} as unknown as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				homeConnectorId: 'default',
			}),
		},
	)

	expect(result).toMatchObject({
		status: 'disconnected',
		connected: false,
		connector_id: 'default',
		connected_at: null,
		last_seen_at: null,
		tool_count: 0,
		error: null,
	})
	expect(result.message).toContain('default')
	expect(result.message).toContain('not currently connected')
})
