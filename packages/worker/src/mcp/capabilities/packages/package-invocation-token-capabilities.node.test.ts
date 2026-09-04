import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	listPackageInvocationTokensByPackageId: vi.fn(),
	getPackageInvocationTokenById: vi.fn(),
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
}))

vi.mock('#worker/package-invocations/repo.ts', () => ({
	listPackageInvocationTokensByPackageId: (...args: Array<unknown>) =>
		mockModule.listPackageInvocationTokensByPackageId(...args),
	getPackageInvocationTokenById: (...args: Array<unknown>) =>
		mockModule.getPackageInvocationTokenById(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

const { packageInvocationTokenListCapability } =
	await import('./package-invocation-token-list.ts')
const { packageInvocationTokenGetCapability } =
	await import('./package-invocation-token-get.ts')

const tokenRecord = {
	id: 'pit-1',
	user_id: 'user-1',
	package_id: 'package-1',
	token_hash: 'stored-token-hash',
	name: 'Discord gateway',
	export_names_json: '["./dispatch-event"]',
	created_at: '2026-07-01T00:00:00.000Z',
	updated_at: '2026-07-02T00:00:00.000Z',
	last_used_at: '2026-07-03T00:00:00.000Z',
	revoked_at: null,
	exportNames: ['./dispatch-event'],
}

function createCapabilityContext() {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
		}),
	}
}

test('package invocation token capabilities return package-scoped metadata without secrets', async () => {
	mockModule.listPackageInvocationTokensByPackageId.mockReset()
	mockModule.getPackageInvocationTokenById.mockReset()
	mockModule.getSavedPackageById.mockReset()
	mockModule.getSavedPackageByKodyId.mockReset()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'discord-gateway',
	})
	mockModule.listPackageInvocationTokensByPackageId.mockResolvedValue([
		tokenRecord,
	])
	mockModule.getPackageInvocationTokenById.mockResolvedValue({
		...tokenRecord,
		id: 'pit-2',
		name: 'Revoked client',
		last_used_at: null,
		revoked_at: '2026-07-04T00:00:00.000Z',
	})

	const context = createCapabilityContext()
	const listResult = await packageInvocationTokenListCapability.handler(
		{ package_id: 'package-1' },
		context,
	)

	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(
		expect.anything(),
		{ userId: 'user-1', packageId: 'package-1' },
	)
	expect(
		mockModule.listPackageInvocationTokensByPackageId,
	).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: 'user-1',
		packageId: 'package-1',
	})
	expect(listResult).toEqual({
		tokens: [
			{
				token_id: 'pit-1',
				name: 'Discord gateway',
				package_id: 'package-1',
				export_names: ['./dispatch-event'],
				created_at: '2026-07-01T00:00:00.000Z',
				updated_at: '2026-07-02T00:00:00.000Z',
				last_used_at: '2026-07-03T00:00:00.000Z',
				revoked_at: null,
			},
		],
	})
	expect(JSON.stringify(listResult)).not.toContain('stored-token-hash')

	const getResult = await packageInvocationTokenGetCapability.handler(
		{ token_id: 'pit-2' },
		context,
	)
	expect(mockModule.getPackageInvocationTokenById).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: 'user-1',
		tokenId: 'pit-2',
	})
	expect(getResult).toEqual({
		token: {
			token_id: 'pit-2',
			name: 'Revoked client',
			package_id: 'package-1',
			export_names: ['./dispatch-event'],
			created_at: '2026-07-01T00:00:00.000Z',
			updated_at: '2026-07-02T00:00:00.000Z',
			last_used_at: null,
			revoked_at: '2026-07-04T00:00:00.000Z',
		},
	})
	expect(JSON.stringify(getResult)).not.toContain('stored-token-hash')

	mockModule.getPackageInvocationTokenById.mockResolvedValue(null)
	await expect(
		packageInvocationTokenGetCapability.handler(
			{ token_id: 'other-user-token' },
			context,
		),
	).rejects.toThrow(/not found/i)
	expect(mockModule.getPackageInvocationTokenById).toHaveBeenLastCalledWith({
		db: expect.anything(),
		userId: 'user-1',
		tokenId: 'other-user-token',
	})

	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.getSavedPackageByKodyId.mockResolvedValue({
		id: 'package-1',
		kodyId: 'discord-gateway',
	})
	await packageInvocationTokenListCapability.handler(
		{ package_id: 'discord-gateway' },
		context,
	)
	expect(mockModule.getSavedPackageByKodyId).toHaveBeenCalledWith(
		expect.anything(),
		{ userId: 'user-1', kodyId: 'discord-gateway' },
	)

	mockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	await expect(
		packageInvocationTokenListCapability.handler(
			{ package_id: 'missing' },
			context,
		),
	).rejects.toThrow(/not found/i)
})
