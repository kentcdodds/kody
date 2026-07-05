import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
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
		description: 'Get the active Roku app on an adopted device.',
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
							connectorId: 'roku',
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

test('meta_list_capabilities lists runtime remote tools and filters by domain', async () => {
	const remoteResult = await metaListCapabilitiesCapability.handler(
		{
			detail: true,
		},
		{
			env: buildRemoteConnectorEnv(),
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: {
					userId: 'user-1',
					email: 'user-1@example.com',
					displayName: 'user-1',
				},
				remoteConnectors: [{ kind: 'roku', instanceId: 'roku' }],
			}),
		},
	)

	expect(remoteResult.capabilities.length).toBeGreaterThan(0)
	expect(
		remoteResult.capabilities.some(
			(capability) => capability.name === 'meta_list_capabilities',
		),
	).toBe(true)
	const pressKeyCapability = remoteResult.capabilities.find(
		(capability) => capability.name === 'remote:roku:roku_press_key',
	)
	const listAppsCapability = remoteResult.capabilities.find(
		(capability) => capability.name === 'remote:roku:roku_list_apps',
	)
	const activeAppCapability = remoteResult.capabilities.find(
		(capability) => capability.name === 'remote:roku:roku_get_active_app',
	)
	expect(pressKeyCapability).toMatchObject({
		domain: 'remote:roku',
		source: 'remote-connector',
		remoteConnector: {
			kind: 'roku',
			instanceId: 'roku',
			connectorId: 'roku',
			connectorName: 'roku',
			mcpToolName: 'roku_press_key',
			toolName: 'roku_press_key',
		},
		requiredInputFields: ['deviceId', 'key'],
		inputTypeDefinition: expect.any(String),
	})
	expect(pressKeyCapability).not.toHaveProperty('inputSchema')
	expect(listAppsCapability).toMatchObject({
		domain: 'remote:roku',
		outputTypeDefinition: expect.any(String),
	})
	expect(listAppsCapability).not.toHaveProperty('outputSchema')
	expect(activeAppCapability?.domain).toBe('remote:roku')

	const metaOnly = await metaListCapabilitiesCapability.handler(
		{
			domain: 'meta',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
			}),
		},
	)

	expect(metaOnly.total).toBeGreaterThan(0)
	expect(
		metaOnly.capabilities.every((capability) => capability.domain === 'meta'),
	).toBe(true)
	expect(
		metaOnly.capabilities.some(
			(capability) => capability.name === 'meta_list_capabilities',
		),
	).toBe(true)

	const packagesOnly = await metaListCapabilitiesCapability.handler(
		{
			domain: 'packages',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
			}),
		},
	)

	expect(packagesOnly.total).toBeGreaterThan(0)
	expect(
		packagesOnly.capabilities.every(
			(capability) => capability.domain === 'packages',
		),
	).toBe(true)

	const remoteOnly = await metaListCapabilitiesCapability.handler(
		{
			domain: 'remote:roku',
		},
		{
			env: buildRemoteConnectorEnv(),
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: {
					userId: 'user-1',
					email: 'user-1@example.com',
					displayName: 'user-1',
				},
				remoteConnectors: [{ kind: 'roku', instanceId: 'roku' }],
			}),
		},
	)

	expect(remoteOnly.total).toBeGreaterThan(0)
	expect(
		remoteOnly.capabilities.every(
			(capability) => capability.domain === 'remote:roku',
		),
	).toBe(true)
	expect(
		remoteOnly.capabilities.some(
			(capability) => capability.name === 'remote:roku:roku_press_key',
		),
	).toBe(true)
})
