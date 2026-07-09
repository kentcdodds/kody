import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	listPackageInvocationTokensByUserId: vi.fn(),
	getPackageInvocationTokenById: vi.fn(),
}))

vi.mock('#worker/package-invocations/repo.ts', () => ({
	listPackageInvocationTokensByUserId: (...args: Array<unknown>) =>
		mockModule.listPackageInvocationTokensByUserId(...args),
	getPackageInvocationTokenById: (...args: Array<unknown>) =>
		mockModule.getPackageInvocationTokenById(...args),
}))

const { packageInvocationTokenListCapability } =
	await import('./package-invocation-token-list.ts')
const { packageInvocationTokenGetCapability } =
	await import('./package-invocation-token-get.ts')

const tokenRecord = {
	id: 'pit-1',
	user_id: 'user-1',
	token_hash: 'stored-token-hash',
	name: 'Discord gateway',
	email: 'user@example.com',
	display_name: 'User',
	package_ids_json: '["package-1"]',
	package_kody_ids_json: '["discord-gateway","*"]',
	export_names_json: '["./dispatch-event"]',
	sources_json: '["discord-fly-proxy"]',
	created_at: '2026-07-01T00:00:00.000Z',
	updated_at: '2026-07-02T00:00:00.000Z',
	last_used_at: '2026-07-03T00:00:00.000Z',
	revoked_at: null,
	packageIds: ['package-1'],
	packageKodyIds: ['discord-gateway', '*'],
	exportNames: ['./dispatch-event'],
	sources: ['discord-fly-proxy'],
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

test('package invocation token capabilities return user-scoped metadata without secrets', async () => {
	mockModule.listPackageInvocationTokensByUserId.mockReset()
	mockModule.getPackageInvocationTokenById.mockReset()
	mockModule.listPackageInvocationTokensByUserId.mockResolvedValue([
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
		{},
		context,
	)

	expect(mockModule.listPackageInvocationTokensByUserId).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: 'user-1',
	})
	expect(listResult).toEqual({
		tokens: [
			{
				token_id: 'pit-1',
				name: 'Discord gateway',
				package_ids: ['package-1'],
				package_kody_ids: ['discord-gateway', '*'],
				export_names: ['./dispatch-event'],
				allowed_sources: ['discord-fly-proxy'],
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
			package_ids: ['package-1'],
			package_kody_ids: ['discord-gateway', '*'],
			export_names: ['./dispatch-event'],
			allowed_sources: ['discord-fly-proxy'],
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
})
