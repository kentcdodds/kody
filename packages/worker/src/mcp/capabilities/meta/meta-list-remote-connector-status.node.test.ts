import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { metaListRemoteConnectorStatusCapability } from './meta-list-remote-connector-status.ts'

function createEnvWithSnapshots(
	snapshots: Record<
		string,
		{
			connectorKind?: string
			connectorId: string
			connectedAt: string
			lastSeenAt: string
			tools: Array<{ name: string }>
		} | null
	>,
) {
	return {
		HOME_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get(id: string) {
				return {
					getSnapshot() {
						return Promise.resolve(snapshots[id] ?? null)
					},
				}
			},
		},
	} as unknown as Env
}

test('meta_list_remote_connector_status reports trust for attached connectors', async () => {
	const result = await metaListRemoteConnectorStatusCapability.handler(
		{},
		{
			env: createEnvWithSnapshots({
				'calendar:primary': {
					connectorKind: 'calendar',
					connectorId: 'primary',
					connectedAt: '2026-05-05T00:00:00.000Z',
					lastSeenAt: '2026-05-05T00:00:01.000Z',
					tools: [{ name: 'events_list' }],
				},
				default: {
					connectorId: 'default',
					connectedAt: '2026-05-05T00:00:00.000Z',
					lastSeenAt: '2026-05-05T00:00:01.000Z',
					tools: [{ name: 'roku_press_key' }],
				},
			}),
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				remoteConnectors: [
					{ kind: 'calendar', instanceId: 'primary' },
					{ kind: 'home', instanceId: 'default' },
				],
			}),
		},
	)

	expect(result.connectors).toEqual([
		expect.objectContaining({
			connector_kind: 'calendar',
			connector_instance_id: 'primary',
			trusted: false,
			status: 'connected',
			tool_count: 1,
		}),
		expect.objectContaining({
			connector_kind: 'home',
			connector_instance_id: 'default',
			trusted: true,
			status: 'connected',
			tool_count: 1,
		}),
	])
	expect(result.connectors[0]?.message).toContain('not trusted')
})
