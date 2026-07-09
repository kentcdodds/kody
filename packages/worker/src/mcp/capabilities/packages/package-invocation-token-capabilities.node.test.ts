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

const { capabilityMap, capabilitySpecs } =
	await import('#mcp/capabilities/registry.ts')
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

test('package invocation token capabilities are registered for discovery', () => {
	expect(capabilityMap.package_invocation_token_list).toBe(
		packageInvocationTokenListCapability,
	)
	expect(capabilityMap.package_invocation_token_get).toBe(
		packageInvocationTokenGetCapability,
	)
	expect(capabilitySpecs.package_invocation_token_list).toMatchObject({
		domain: 'packages',
		readOnly: true,
		idempotent: true,
		destructive: false,
		outputFields: ['tokens'],
	})
	expect(capabilitySpecs.package_invocation_token_get).toMatchObject({
		domain: 'packages',
		readOnly: true,
		idempotent: true,
		destructive: false,
		requiredInputFields: ['token_id'],
		outputFields: ['token'],
	})
})

test('package_invocation_token_list returns user-scoped metadata without token hashes', async () => {
	mockModule.listPackageInvocationTokensByUserId.mockReset()
	mockModule.listPackageInvocationTokensByUserId.mockResolvedValue([
		tokenRecord,
	])

	const result = await packageInvocationTokenListCapability.handler(
		{},
		createCapabilityContext(),
	)

	expect(mockModule.listPackageInvocationTokensByUserId).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: 'user-1',
	})
	const serialized = JSON.stringify(result)
	expect(serialized).not.toContain('stored-token-hash')
	expect(serialized).not.toContain('user@example.com')
	expect(serialized).not.toContain('"display_name"')
	expect(result).toEqual({
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
})

test('package_invocation_token_get returns one user-scoped metadata record', async () => {
	mockModule.getPackageInvocationTokenById.mockReset()
	mockModule.getPackageInvocationTokenById.mockResolvedValue({
		...tokenRecord,
		id: 'pit-2',
		name: 'Revoked client',
		last_used_at: null,
		revoked_at: '2026-07-04T00:00:00.000Z',
	})

	const result = await packageInvocationTokenGetCapability.handler(
		{ token_id: 'pit-2' },
		createCapabilityContext(),
	)

	expect(mockModule.getPackageInvocationTokenById).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: 'user-1',
		tokenId: 'pit-2',
	})
	const serialized = JSON.stringify(result)
	expect(serialized).not.toContain('stored-token-hash')
	expect(serialized).not.toContain('user@example.com')
	expect(serialized).not.toContain('"display_name"')
	expect(result).toEqual({
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
})

test('package_invocation_token_get rejects tokens outside the signed-in user scope', async () => {
	mockModule.getPackageInvocationTokenById.mockReset()
	mockModule.getPackageInvocationTokenById.mockResolvedValue(null)

	await expect(
		packageInvocationTokenGetCapability.handler(
			{ token_id: 'other-user-token' },
			createCapabilityContext(),
		),
	).rejects.toThrow('Package invocation token not found for this user.')
	expect(mockModule.getPackageInvocationTokenById).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: 'user-1',
		tokenId: 'other-user-token',
	})
})
