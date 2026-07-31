import { expect, test, vi } from 'vitest'
import { handleOwnerlessMcpSessionPurgeRequest } from './mcp-ownerless-purge-maintenance.ts'

test('ownerless MCP purge maintenance purges only ownerless ids', async () => {
	const stubs = new Map([
		[
			'orphan-1',
			{
				getStoredOwnerForMaintenance: vi.fn(async () => ({
					doId: 'orphan-1',
					userId: null,
				})),
				purgeIfOwnerlessForMaintenance: vi.fn(async () => ({
					doId: 'orphan-1',
					action: 'purged' as const,
				})),
			},
		],
		[
			'owned-1',
			{
				getStoredOwnerForMaintenance: vi.fn(async () => ({
					doId: 'owned-1',
					userId: 'user-a',
				})),
				purgeIfOwnerlessForMaintenance: vi.fn(async () => {
					throw new Error('should not purge owned')
				}),
			},
		],
	])
	const response = await handleOwnerlessMcpSessionPurgeRequest(
		new Request(
			'https://example.com/__maintenance/purge-ownerless-mcp-sessions',
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer maintenance-secret',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ doIds: ['orphan-1', 'owned-1'] }),
			},
		),
		{
			CAPABILITY_REINDEX_SECRET: 'maintenance-secret',
			MCP_OBJECT: {
				idFromString: (id: string) => id,
				get: (id: string) => stubs.get(id),
			},
		} as unknown as Env,
	)
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		scanned: 2,
		purgedCount: 1,
		skippedCount: 1,
		failureCount: 0,
		purged: ['orphan-1'],
		skipped: [{ doId: 'owned-1', reason: 'has_owner' }],
	})
	expect(
		stubs.get('orphan-1')?.purgeIfOwnerlessForMaintenance,
	).toHaveBeenCalled()
	expect(
		stubs.get('owned-1')?.purgeIfOwnerlessForMaintenance,
	).not.toHaveBeenCalled()
})
