import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { metaListCapabilitiesCapability } from './meta-list-capabilities.ts'

const runtimeHomeTools = [
	{
		name: 'roku_press_key',
		title: 'Press Roku Key',
		description: 'Send a Roku ECP keypress to an adopted Roku device.',
		inputSchema: {
			type: 'object',
			properties: {
				deviceId: { type: 'string' },
				key: { type: 'string' },
			},
			required: ['deviceId', 'key'],
		},
	},
	{
		name: 'roku_list_apps',
		title: 'List Roku Apps',
		description:
			'List installed Roku apps on an adopted device using the Roku ECP app query.',
		inputSchema: {
			type: 'object',
			properties: {
				deviceId: { type: 'string' },
			},
			required: ['deviceId'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				apps: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
						},
					},
				},
			},
		},
	},
	{
		name: 'roku_get_active_app',
		title: 'Get Active Roku App',
		description: 'Get the currently active Roku app on an adopted device.',
		inputSchema: {
			type: 'object',
			properties: {
				deviceId: { type: 'string' },
			},
			required: ['deviceId'],
		},
		outputSchema: {
			type: 'object',
			properties: {
				app: {
					anyOf: [{ type: 'object' }, { type: 'null' }],
				},
			},
		},
	},
] as const

test('meta_list_capabilities includes runtime home capabilities from the connected connector', async () => {
	const env = {
		HOME_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get() {
				return {
					fetch(input: string | URL | Request) {
						const url = new URL(
							typeof input === 'string'
								? input
								: input instanceof URL
									? input.toString()
									: input.url,
						)
						if (url.pathname.endsWith('/snapshot')) {
							return Promise.resolve(
								Response.json({
									connectorId: 'default',
									connectedAt: '2026-03-25T00:00:00.000Z',
									lastSeenAt: '2026-03-25T00:00:01.000Z',
									tools: runtimeHomeTools,
								}),
							)
						}
						throw new Error(`Unexpected fetch to ${url.pathname}`)
					},
				}
			},
		},
	} as unknown as Env

	const result = await metaListCapabilitiesCapability.handler(
		{
			detail: true,
		},
		{
			env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				homeConnectorId: 'default',
			}),
		},
	)

	expect(result.capabilities.length).toBeGreaterThan(0)
	expect(
		result.capabilities.some(
			(capability) => capability.name === 'meta_list_capabilities',
		),
	).toBe(true)
	const homeCapability = result.capabilities.find(
		(capability) => capability.name === 'home_roku_press_key',
	)
	const listAppsCapability = result.capabilities.find(
		(capability) => capability.name === 'home_roku_list_apps',
	)
	const activeAppCapability = result.capabilities.find(
		(capability) => capability.name === 'home_roku_get_active_app',
	)
	expect(homeCapability).not.toBeUndefined()
	expect(homeCapability?.domain).toBe('home')
	expect(homeCapability?.requiredInputFields).toEqual(['deviceId', 'key'])
	expect(listAppsCapability).not.toBeUndefined()
	expect(listAppsCapability?.domain).toBe('home')
	expect(activeAppCapability).not.toBeUndefined()
	expect(activeAppCapability?.domain).toBe('home')
})

test('meta_list_capabilities filters by domain', async () => {
	const env = {} as Env

	const result = await metaListCapabilitiesCapability.handler(
		{
			domain: 'meta',
		},
		{
			env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
			}),
		},
	)

	expect(result.total).toBeGreaterThan(0)
	expect(
		result.capabilities.every((capability) => capability.domain === 'meta'),
	).toBe(true)
	expect(
		result.capabilities.some(
			(capability) => capability.name === 'meta_list_capabilities',
		),
	).toBe(true)
})
