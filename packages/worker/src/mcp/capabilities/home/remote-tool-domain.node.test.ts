import { type HomeConnectorSnapshot } from '#worker/home/types.ts'
import { expect, test } from 'vitest'
import { synthesizeRemoteToolDomain } from './index.ts'

function createEnvWithSnapshot(snapshot: HomeConnectorSnapshot) {
	return {
		HOME_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get() {
				return {
					async getSnapshot() {
						return snapshot
					},
				}
			},
		},
	} as unknown as Env
}

function stubSnapshot(): HomeConnectorSnapshot {
	return {
		connectorKind: 'github',
		connectorId: 'work',
		connectedAt: '2026-05-05T00:00:00.000Z',
		lastSeenAt: '2026-05-05T00:00:01.000Z',
		tools: [
			{
				name: 'list_repos',
				description: 'List repositories.',
				inputSchema: { type: 'object', properties: {} },
				annotations: { readOnlyHint: true },
			},
		],
	}
}

test('does not synthesize capabilities for untrusted generic connectors', async () => {
	const ref = { kind: 'github', instanceId: 'work', trusted: false }

	const domain = await synthesizeRemoteToolDomain(
		createEnvWithSnapshot(stubSnapshot()),
		ref,
		[ref],
	)

	expect(domain).toBeNull()
})

test('synthesizes distinct capability names for trusted generic connectors', async () => {
	const ref = { kind: 'github', instanceId: 'work', trusted: true }

	const domain = await synthesizeRemoteToolDomain(
		createEnvWithSnapshot(stubSnapshot()),
		ref,
		[ref],
	)

	expect(domain?.domain.name).toBe('remote:github:work')
	expect(domain?.domain.capabilities).toEqual([
		expect.objectContaining({
			name: 'github_work_list_repos',
			domain: 'remote:github:work',
			readOnly: true,
			destructive: false,
		}),
	])
	expect(domain?.bindings).toMatchObject({
		github_work_list_repos: {
			kind: 'github',
			instanceId: 'work',
			mcpToolName: 'list_repos',
		},
	})
})

test('keeps legacy home naming when only executable connector is home default', async () => {
	const ref = { kind: 'home', instanceId: 'default', trusted: true }
	const untrustedRef = { kind: 'github', instanceId: 'work', trusted: false }
	const snapshot: HomeConnectorSnapshot = {
		connectorId: 'default',
		connectedAt: '2026-05-05T00:00:00.000Z',
		lastSeenAt: '2026-05-05T00:00:01.000Z',
		tools: [
			{
				name: 'roku_press_key',
				description: 'Press a Roku key.',
				inputSchema: { type: 'object', properties: {} },
			},
		],
	}

	const domain = await synthesizeRemoteToolDomain(
		createEnvWithSnapshot(snapshot),
		ref,
		[ref, untrustedRef],
	)

	expect(domain?.domain.name).toBe('home')
	expect(domain?.domain.capabilities).toEqual([
		expect.objectContaining({
			name: 'home_roku_press_key',
			domain: 'home',
		}),
	])
})
