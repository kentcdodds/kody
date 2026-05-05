import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	createHomeToolErrorResult,
	resolveHomeBridgeRef,
} from './mcp-bridge.ts'

test('resolveHomeBridgeRef preserves explicit distrust', () => {
	const ref = resolveHomeBridgeRef(
		createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			remoteConnectors: [
				{ kind: 'home', instanceId: 'default', trusted: false },
			],
		}),
	)

	expect(ref).toEqual({
		kind: 'home',
		instanceId: 'default',
		trusted: false,
	})
})

test('home bridge trust errors use unavailable status message', async () => {
	const result = await createHomeToolErrorResult(
		{
			getCallerContext() {
				return createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
					remoteConnectors: [
						{ kind: 'home', instanceId: 'default', trusted: false },
					],
				})
			},
			getEnv() {
				return {
					HOME_CONNECTOR_SESSION: {
						idFromName(name: string) {
							return name
						},
						get() {
							return {
								getSnapshot() {
									return Promise.resolve({
										connectorId: 'default',
										connectedAt: '2026-05-05T00:00:00.000Z',
										lastSeenAt: '2026-05-05T00:00:01.000Z',
										tools: [{ name: 'roku_press_key' }],
									})
								},
							}
						},
					},
				} as unknown as Env
			},
			requireDomain() {
				return 'https://heykody.dev'
			},
			async getHomeClient() {
				throw new Error('not used')
			},
		},
		new Error('Home connector is not trusted for this session.'),
	)

	expect(result.isError).toBe(true)
	expect(result.structuredContent).toMatchObject({
		homeConnectorStatus: {
			trusted: false,
			state: 'connected',
		},
	})
	expect(result.content[0]).toMatchObject({
		text: expect.stringContaining('not trusted'),
	})
})
