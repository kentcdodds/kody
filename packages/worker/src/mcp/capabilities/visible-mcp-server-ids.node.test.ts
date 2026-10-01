import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	runWithCurrentSecretAuthority,
	runWithSecretAuthorityScope,
} from '#mcp/secrets/secret-authority.ts'

const listVisibleMocks = vi.hoisted(() => ({
	listVisibleEnabledMcpServerRefsCached: vi.fn(),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	listVisibleEnabledMcpServerRefsCached: (...args: Array<unknown>) =>
		listVisibleMocks.listVisibleEnabledMcpServerRefsCached(...(args as [])),
}))

const { listVisibleMcpServerIdsForCaller } =
	await import('./visible-mcp-server-ids.ts')

test('listVisibleMcpServerIdsForCaller uses stamp packageId and null for bare execute', async () => {
	listVisibleMocks.listVisibleEnabledMcpServerRefsCached.mockImplementation(
		async (input?: { packageId?: string | null }) => {
			if (input?.packageId === 'pkg-notion-read') {
				return [{ serverId: 'server-notion', name: 'notion' }]
			}
			return []
		},
	)
	const executeContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'user',
			roles: ['user'],
		},
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: null,
			storageId: null,
		},
	})
	const env = { APP_DB: {} } as unknown as Env

	const bare = await listVisibleMcpServerIdsForCaller({
		env,
		userId: 'user-1',
		callerContext: executeContext,
	})
	expect(
		listVisibleMocks.listVisibleEnabledMcpServerRefsCached,
	).toHaveBeenLastCalledWith(expect.objectContaining({ packageId: null }))
	expect([...bare]).toEqual([])

	const stamped = await runWithSecretAuthorityScope(
		new Set(['pkg-notion-read']),
		async () =>
			runWithCurrentSecretAuthority('pkg-notion-read', async () =>
				listVisibleMcpServerIdsForCaller({
					env,
					userId: 'user-1',
					callerContext: executeContext,
				}),
			),
	)
	expect(
		listVisibleMocks.listVisibleEnabledMcpServerRefsCached,
	).toHaveBeenLastCalledWith(
		expect.objectContaining({ packageId: 'pkg-notion-read' }),
	)
	expect([...stamped]).toEqual(['server-notion'])
})
