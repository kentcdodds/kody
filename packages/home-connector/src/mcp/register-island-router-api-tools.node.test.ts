import { expect, test } from 'vitest'
import {
	islandRouterApiWriteConfirmation,
	type createIslandRouterApiAdapter,
} from '../adapters/island-router-api/index.ts'
import { registerIslandRouterApiHomeConnectorTools } from './register-island-router-api-tools.ts'

test('registers Island Router API proxy tools and handlers call the adapter', async () => {
	const calls: Array<{
		method: string
		path: string
		acknowledgeHighRisk?: boolean
		reason?: string
		confirmation?: string
	}> = []
	const islandRouterApi = {
		writeConfirmation: islandRouterApiWriteConfirmation,
		getStatus() {
			return {
				configured: true,
				hasStoredPin: true,
				lastAuthenticatedAt: null,
				lastAuthError: null,
				baseUrl: 'https://my.islandrouter.com',
			}
		},
		setPin(pin: string) {
			expect(pin).toBe('123456')
			return this.getStatus()
		},
		clearPin() {
			return {
				...this.getStatus(),
				configured: false,
				hasStoredPin: false,
			}
		},
		async request(input: {
			method: 'GET' | 'POST' | 'PUT' | 'DELETE'
			path: string
			acknowledgeHighRisk?: boolean
			reason?: string
			confirmation?: string
		}) {
			calls.push(input)
			return {
				method: input.method,
				path: input.path,
				query: null,
				status: 200,
				data: { ok: true },
			}
		},
	} satisfies ReturnType<typeof createIslandRouterApiAdapter>
	const tools = new Map<
		string,
		{
			inputSchema: Record<string, unknown>
			handler: (args: Record<string, unknown>) => Promise<unknown>
		}
	>()

	registerIslandRouterApiHomeConnectorTools({
		islandRouterApi,
		registerTool(descriptor, handler) {
			tools.set(descriptor.name, {
				inputSchema: descriptor.inputSchema,
				handler,
			})
		},
	})

	expect([...tools.keys()]).toEqual([
		'island_router_api_get_status',
		'island_router_api_set_pin',
		'island_router_api_clear_pin',
		'island_router_api_request',
	])
	expect(tools.get('island_router_api_set_pin')?.inputSchema).toMatchObject({
		properties: {
			pin: {
				'x-kody-secret': true,
			},
		},
	})
	expect(
		await tools.get('island_router_api_get_status')?.handler({}),
	).toMatchObject({
		structuredContent: {
			configured: true,
			hasStoredPin: true,
		},
	})
	expect(
		await tools.get('island_router_api_set_pin')?.handler({ pin: '123456' }),
	).toMatchObject({
		structuredContent: {
			hasStoredPin: true,
		},
	})
	expect(
		await tools.get('island_router_api_request')?.handler({
			method: 'POST',
			path: '/api/filters',
			body: { name: 'Example' },
			acknowledgeHighRisk: true,
			reason: 'Create the test filter requested by the operator.',
			confirmation: islandRouterApiWriteConfirmation,
		}),
	).toMatchObject({
		structuredContent: {
			method: 'POST',
			path: '/api/filters',
			status: 200,
			data: { ok: true },
		},
	})
	expect(calls).toEqual([
		expect.objectContaining({
			method: 'POST',
			path: '/api/filters',
			acknowledgeHighRisk: true,
			confirmation: islandRouterApiWriteConfirmation,
		}),
	])
})
