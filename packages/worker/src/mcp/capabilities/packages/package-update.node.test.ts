import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	updateSavedPackage: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
}))

const { packageUpdateCapability } = await import('./package-update.ts')

function createCtx(userId = 'user-1') {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email: 'user@example.com',
				displayName: 'User',
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

function createSavedPackage(hidden: boolean) {
	return {
		id: 'pkg-1',
		userId: 'user-1',
		kodyId: 'notes',
		name: '@user/notes',
		description: 'Personal notes',
		tags: ['notes'],
		searchText: null,
		hasApp: false,
		hidden,
		sourceId: 'source-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

test('package_update hides and unhides a user-scoped package and returns persisted summaries', async () => {
	mockModule.updateSavedPackage.mockResolvedValue(true)
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage(true))
		.mockResolvedValueOnce(createSavedPackage(false))

	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: { hidden: true } },
			createCtx(),
		),
	).resolves.toEqual({
		ok: true,
		package: {
			package_id: 'pkg-1',
			kody_id: 'notes',
			name: '@user/notes',
			description: 'Personal notes',
			tags: ['notes'],
			has_app: false,
			hidden: true,
			source_id: 'source-1',
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-07-14T00:00:00.000Z',
		},
	})
	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: { hidden: false } },
			createCtx(),
		),
	).resolves.toMatchObject({
		ok: true,
		package: {
			package_id: 'pkg-1',
			kody_id: 'notes',
			name: '@user/notes',
			hidden: false,
		},
	})

	expect(mockModule.updateSavedPackage).toHaveBeenNthCalledWith(
		1,
		{},
		{
			userId: 'user-1',
			packageId: 'pkg-1',
			hidden: true,
		},
	)
	expect(mockModule.updateSavedPackage).toHaveBeenNthCalledWith(
		2,
		{},
		{
			userId: 'user-1',
			packageId: 'pkg-1',
			hidden: false,
		},
	)
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(2)
})

test('package_update rejects empty or canonical metadata changes before writing', async () => {
	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: {} },
			createCtx(),
		),
	).rejects.toThrow('Provide at least one supported package change.')
	await expect(
		packageUpdateCapability.handler(
			{
				package_id: 'pkg-1',
				changes: { name: '@user/renamed' },
			},
			createCtx(),
		),
	).rejects.toThrow()
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})

test('package_update rejects missing, cross-user, and unauthenticated access', async () => {
	mockModule.updateSavedPackage.mockResolvedValueOnce(false)
	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'other-user-package', changes: { hidden: true } },
			createCtx('user-2'),
		),
	).rejects.toThrow('Saved package not found for this user.')
	expect(mockModule.updateSavedPackage).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-2',
			packageId: 'other-user-package',
			hidden: true,
		},
	)

	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: { hidden: true } },
			{
				env: { APP_DB: {} } as Env,
				callerContext: {
					baseUrl: 'https://heykody.dev',
					user: null,
					remoteConnectors: null,
					storageContext: null,
					repoContext: null,
				},
			},
		),
	).rejects.toThrow('Authenticated MCP user is required')
	expect(mockModule.updateSavedPackage).toHaveBeenCalledTimes(1)
})
