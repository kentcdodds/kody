import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	updateSavedPackage: vi.fn(),
	setSavedPackageLockedAt: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
	setSavedPackageLockedAt: (...args: Array<unknown>) =>
		mockModule.setSavedPackageLockedAt(...args),
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
			storageContext: null,
			repoContext: null,
		},
	}
}

function createSavedPackage(input?: {
	hidden?: boolean
	lockedAt?: string | null
}) {
	return {
		id: 'pkg-1',
		userId: 'user-1',
		kodyId: 'notes',
		name: '@user/notes',
		description: 'Personal notes',
		tags: ['notes'],
		searchText: null,
		hasApp: false,
		hidden: input?.hidden ?? false,
		isPrivate: false,
		lockedAt: input?.lockedAt ?? null,
		sourceId: 'source-1',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

test('package_update hides and unhides a user-scoped package and returns persisted summaries', async () => {
	mockModule.updateSavedPackage.mockResolvedValue(true)
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(createSavedPackage({ hidden: true }))
		.mockResolvedValueOnce(createSavedPackage({ hidden: true }))
		.mockResolvedValueOnce(createSavedPackage({ hidden: false }))

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
			visibility: 'public',
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
			visibility: 'public',
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
	expect(mockModule.setSavedPackageLockedAt).not.toHaveBeenCalled()
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(4)
})

test('package_update locks a package and rejects unlock with the owner website URL', async () => {
	const lockedPackage = createSavedPackage({
		lockedAt: '2026-08-28T12:00:00.000Z',
	})
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(lockedPackage)
		.mockResolvedValue(lockedPackage)
	mockModule.setSavedPackageLockedAt.mockResolvedValue(true)

	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: { locked: true } },
			createCtx(),
		),
	).resolves.toMatchObject({
		ok: true,
		package: {
			package_id: 'pkg-1',
			locked_at: '2026-08-28T12:00:00.000Z',
		},
	})
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			packageId: 'pkg-1',
			lockedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		},
	)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()

	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: { locked: true } },
			createCtx(),
		),
	).resolves.toMatchObject({
		ok: true,
		package: {
			package_id: 'pkg-1',
			locked_at: '2026-08-28T12:00:00.000Z',
		},
	})
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(1)

	const unlockError = await packageUpdateCapability
		.handler({ package_id: 'pkg-1', changes: { locked: false } }, createCtx())
		.catch((error: unknown) => error)
	expect(unlockError).toBeInstanceOf(McpCallerError)
	expect(unlockError).toMatchObject({
		message:
			'Agents cannot unlock packages. Send the owner to https://heykody.dev/account/packages/pkg-1 to unlock publishes.',
	})
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(1)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()

	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: { hidden: true, locked: false } },
			createCtx(),
		),
	).rejects.toThrow(/cannot unlock/i)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})

test('package_update rejects invalid changes and cross-user or unauthenticated access', async () => {
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
	).rejects.toThrow('Invalid input for capability "package_update"')
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValueOnce(null)
	await expect(
		packageUpdateCapability.handler(
			{
				package_id: 'other-user-package',
				changes: { hidden: true },
			},
			createCtx('user-2'),
		),
	).rejects.toThrow(/not found/i)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()

	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: { hidden: true } },
			{
				env: { APP_DB: {} } as Env,
				callerContext: {
					baseUrl: 'https://heykody.dev',
					user: null,
					storageContext: null,
					repoContext: null,
				},
			},
		),
	).rejects.toThrow(/authenticated/i)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})
