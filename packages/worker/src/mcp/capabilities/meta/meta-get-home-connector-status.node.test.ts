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
							fetch() {
								return Promise.resolve(
									Response.json({
										connectorId: 'default',
										connectedAt: '2026-03-25T00:00:00.000Z',
										lastSeenAt: '2026-03-25T00:00:01.000Z',
										tools: [{ name: 'roku_press_key' }],
									}),
								)
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

	expect(result).toEqual({
		status: 'connected',
		connected: true,
		connector_id: 'default',
		connected_at: '2026-03-25T00:00:00.000Z',
		last_seen_at: '2026-03-25T00:00:01.000Z',
		tool_count: 1,
		message: 'The home connector "default" is connected and exposing 1 tool.',
		error: null,
	})
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
							fetch() {
								return Promise.resolve(Response.json(null))
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

	expect(result).toEqual({
		status: 'disconnected',
		connected: false,
		connector_id: 'default',
		connected_at: null,
		last_seen_at: null,
		tool_count: 0,
		message: 'The home connector "default" is not currently connected.',
		error: null,
	})
})
