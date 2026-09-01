import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	deleteSavedPackageProjection: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	deleteSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.deleteSavedPackageProjection(...args),
}))

const { handleAccountPackageDeleteAction } =
	await import('./account-package-delete.ts')

function createUser() {
	return {
		sessionUserId: '42',
		userId: 42,
		username: 'user',
		email: 'user@example.com',
		displayName: 'user',
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			username: 'user',
			displayName: 'user',
		},
	}
}

function createSavedPackage() {
	return {
		id: 'pkg-1',
		userId: 'stable-user-1',
		name: '@user/notes',
		kodyId: 'notes',
		description: 'Personal notes',
		tags: ['notes'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

test('account package delete requires the typed package name then removes the package', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	expect(
		await handleAccountPackageDeleteAction({
			env,
			user,
			body: { action: 'set-visibility' },
		}),
	).toBeNull()

	const missingId = await handleAccountPackageDeleteAction({
		env,
		user,
		body: { action: 'delete' },
	})
	expect(missingId?.status).toBe(400)
	await expect(missingId?.json()).resolves.toEqual({
		ok: false,
		error: 'Package id is required.',
	})

	mockModule.getSavedPackageById.mockResolvedValueOnce(null)
	const missingPackage = await handleAccountPackageDeleteAction({
		env,
		user,
		body: { action: 'delete', packageId: 'pkg-1', confirmName: '@user/notes' },
	})
	expect(missingPackage?.status).toBe(404)
	await expect(missingPackage?.json()).resolves.toEqual({
		ok: false,
		error: 'Package not found.',
	})
	expect(mockModule.deleteSavedPackageProjection).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage())
	const wrongName = await handleAccountPackageDeleteAction({
		env,
		user,
		body: { action: 'delete', packageId: 'pkg-1', confirmName: 'notes' },
	})
	expect(wrongName?.status).toBe(400)
	await expect(wrongName?.json()).resolves.toEqual({
		ok: false,
		error: 'Type the package name "@user/notes" to delete it.',
	})
	expect(mockModule.deleteSavedPackageProjection).not.toHaveBeenCalled()

	mockModule.deleteSavedPackageProjection.mockResolvedValue(undefined)
	const deleted = await handleAccountPackageDeleteAction({
		env,
		user,
		body: {
			action: 'delete',
			packageId: 'pkg-1',
			confirmName: '@user/notes',
		},
	})
	expect(deleted?.status).toBe(200)
	await expect(deleted?.json()).resolves.toEqual({
		ok: true,
		deleted: true,
		packageId: 'pkg-1',
	})
	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(env.APP_DB, {
		userId: 'stable-user-1',
		packageId: 'pkg-1',
	})
	expect(mockModule.deleteSavedPackageProjection).toHaveBeenCalledWith({
		env,
		userId: 'stable-user-1',
		actorUserId: 'stable-user-1',
		packageId: 'pkg-1',
	})
})
