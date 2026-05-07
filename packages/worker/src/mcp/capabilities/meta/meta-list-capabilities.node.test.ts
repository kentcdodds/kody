import { expect, test } from 'vitest'
import {
	createDefaultMcpCallerContext,
	createMcpCallerContext,
} from '#mcp/context.ts'
import { metaListCapabilitiesCapability } from './meta-list-capabilities.ts'

const runtimeRokuTools = [
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
							connectedAt: '2026-03-25T00:00:00.000Z',
							lastSeenAt: '2026-03-25T00:00:01.000Z',
							tools: runtimeRokuTools,
						})
					},
				}
			},
		},
	} as unknown as Env
}

function buildHomeRemoteConnectorEnv() {
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
							tools: [
								{
									name: 'home_status',
									title: 'Home Status',
									description: 'Read the current home connector status.',
									inputSchema: {
										type: 'object',
										properties: {},
									},
								},
							],
						})
					},
				}
			},
		},
	} as unknown as Env
}

test('meta_list_capabilities includes runtime remote connector capabilities with type definitions only', async () => {
	const env = buildRemoteConnectorEnv()

	const result = await metaListCapabilitiesCapability.handler(
		{
			detail: true,
		},
		{
			env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				remoteConnectors: [{ kind: 'roku', instanceId: 'default' }],
			}),
		},
	)

	expect(result.capabilities.length).toBeGreaterThan(0)
	expect(
		result.capabilities.some(
			(capability) => capability.name === 'meta_list_capabilities',
		),
	).toBe(true)
	const pressKeyCapability = result.capabilities.find(
		(capability) => capability.name === 'roku_default_roku_press_key',
	)
	const listAppsCapability = result.capabilities.find(
		(capability) => capability.name === 'roku_default_roku_list_apps',
	)
	const activeAppCapability = result.capabilities.find(
		(capability) => capability.name === 'roku_default_roku_get_active_app',
	)
	expect(pressKeyCapability).not.toBeUndefined()
	expect(pressKeyCapability?.domain).toBe('remote:roku:default')
	expect(pressKeyCapability?.requiredInputFields).toEqual(['deviceId', 'key'])
	expect(pressKeyCapability?.inputTypeDefinition).toEqual(expect.any(String))
	expect(pressKeyCapability).not.toHaveProperty('inputSchema')
	expect(listAppsCapability).not.toBeUndefined()
	expect(listAppsCapability?.domain).toBe('remote:roku:default')
	expect(listAppsCapability?.outputTypeDefinition).toEqual(expect.any(String))
	expect(listAppsCapability).not.toHaveProperty('outputSchema')
	expect(activeAppCapability).not.toBeUndefined()
	expect(activeAppCapability?.domain).toBe('remote:roku:default')
})

test('meta_list_capabilities includes capabilities from the default home remote connector', async () => {
	const result = await metaListCapabilitiesCapability.handler(
		{
			detail: true,
		},
		{
			env: buildHomeRemoteConnectorEnv(),
			callerContext: createDefaultMcpCallerContext({
				baseUrl: 'https://heykody.dev',
			}),
		},
	)

	const homeStatusCapability = result.capabilities.find(
		(capability) => capability.name === 'home_default_home_status',
	)
	expect(homeStatusCapability).not.toBeUndefined()
	expect(homeStatusCapability?.domain).toBe('remote:home:default')
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
