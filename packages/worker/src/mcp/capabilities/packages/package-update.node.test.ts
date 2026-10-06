import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
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

function update(
	changes: Record<string, unknown>,
	{
		userId = 'user-1' as string | null,
		packageId = 'pkg-1',
	}: { userId?: string | null; packageId?: string } = {},
) {
	if (userId) {
		mockModule.resolvePackageOwnerContext.mockResolvedValue({
			ownerUserId: userId,
			ownerScope: 'user',
			ownerEmail: 'user@example.com',
			actorUserId: userId,
			delegated: false,
		})
	}
	return packageUpdateCapability.handler(
		{ package_id: packageId, changes },
		{
			env: { APP_DB: {} } as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: userId
					? { userId, email: 'user@example.com', displayName: 'User' }
					: null,
			}),
		},
	)
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

test('packageUpdate hides and unhides a user-scoped package and returns persisted summaries', async () => {
	mockModule.updateSavedPackage.mockResolvedValue(true)
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(createSavedPackage({ hidden: true }))
		.mockResolvedValueOnce(createSavedPackage({ hidden: true }))
		.mockResolvedValueOnce(createSavedPackage({ hidden: false }))

	await expect(update({ hidden: true })).resolves.toMatchObject({
		ok: true,
		package: {
			package_id: 'pkg-1',
			kody_id: 'notes',
			slug: 'notes',
			name: '@user/notes',
			hidden: true,
			visibility: 'public',
			source_id: 'source-1',
		},
	})
	await expect(update({ hidden: false })).resolves.toMatchObject({
		ok: true,
		package: {
			package_id: 'pkg-1',
			kody_id: 'notes',
			slug: 'notes',
			hidden: false,
			visibility: 'public',
		},
	})

	expect(mockModule.updateSavedPackage.mock.calls).toEqual([
		[{}, { userId: 'user-1', packageId: 'pkg-1', hidden: true }],
		[{}, { userId: 'user-1', packageId: 'pkg-1', hidden: false }],
	])
	expect(mockModule.setSavedPackageLockedAt).not.toHaveBeenCalled()
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(4)
})

test('packageUpdate locks a package and rejects unlock with the owner website URL', async () => {
	const lockedPackage = createSavedPackage({
		lockedAt: '2026-08-28T12:00:00.000Z',
	})
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(lockedPackage)
		.mockResolvedValue(lockedPackage)
	mockModule.setSavedPackageLockedAt.mockResolvedValue(true)
	const lockedSummary = {
		ok: true,
		package: { package_id: 'pkg-1', locked_at: '2026-08-28T12:00:00.000Z' },
	}

	await expect(update({ locked: true })).resolves.toMatchObject(lockedSummary)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			packageId: 'pkg-1',
			lockedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		},
	)

	await expect(update({ locked: true })).resolves.toMatchObject(lockedSummary)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(1)

	const unlockError = await update({ locked: false }).catch(
		(error: unknown) => error,
	)
	expect(unlockError).toBeInstanceOf(McpCallerError)
	expect(unlockError).toMatchObject({
		message:
			'Agents cannot unlock packages. Send the owner to https://heykody.dev/@user/notes/settings to unlock publishes.',
	})
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(1)

	await expect(update({ hidden: true, locked: false })).rejects.toThrow(
		/cannot unlock/i,
	)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})

test('packageUpdate rejects invalid changes and cross-user or unauthenticated access', async () => {
	await expect(update({})).rejects.toThrow(
		'Provide at least one supported package change.',
	)
	await expect(update({ name: '@user/renamed' })).rejects.toThrow(
		'Invalid input for capability "packageUpdate"',
	)

	mockModule.getSavedPackageById.mockResolvedValueOnce(null)
	await expect(
		update(
			{ hidden: true },
			{ userId: 'user-2', packageId: 'other-user-package' },
		),
	).rejects.toThrow(/not found/i)

	await expect(update({ hidden: true }, { userId: null })).rejects.toThrow(
		/authenticated/i,
	)
	expect(mockModule.updateSavedPackage).not.toHaveBeenCalled()
})
