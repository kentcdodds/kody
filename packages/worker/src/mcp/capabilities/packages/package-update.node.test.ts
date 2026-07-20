import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	updateSavedPackage: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	packageScopeInputDescription: 'package scope',
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

const { packageUpdateCapability } = await import('./package-update.ts')

function createCtx(userId = 'user-1') {
	mockModule.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: userId,
		ownerScope: 'user',
		ownerEmail: 'user@example.com',
		actorUserId: userId,
		delegated: false,
	})
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
		isPrivate: false,
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
	).resolves.toMatchObject({
		ok: true,
		package: {
			package_id: 'pkg-1',
			kody_id: 'notes',
			name: '@user/notes',
			hidden: true,
			source_id: 'source-1',
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

test('package_update rejects invalid changes and cross-user or unauthenticated access', async () => {
	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: {} },
			createCtx(),
		),
	).rejects.toThrow()
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

	mockModule.updateSavedPackage.mockResolvedValueOnce(false)
	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'other-user-package', changes: { hidden: true } },
			createCtx('user-2'),
		),
	).rejects.toThrow(/not found/i)
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
	).rejects.toThrow(/authenticated/i)
	expect(mockModule.updateSavedPackage).toHaveBeenCalledTimes(1)
})
