import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	updateSavedPackage: vi.fn(),
	publishCommunityListing: vi.fn(),
	unpublishCommunityListing: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
	loadAccountPackagesData: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	publishCommunityListing: (...args: Array<unknown>) =>
		mockModule.publishCommunityListing(...args),
	unpublishCommunityListing: (...args: Array<unknown>) =>
		mockModule.unpublishCommunityListing(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage: (...args: Array<unknown>) =>
		mockModule.getCommunityListingByOwnerAndPackage(...args),
}))

vi.mock('#app/account-packages-data.ts', () => ({
	loadAccountPackagesData: (...args: Array<unknown>) =>
		mockModule.loadAccountPackagesData(...args),
}))

const { handleAccountPackageVisibilityAction } =
	await import('./account-package-visibility.ts')

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

function createSavedPackage(isPrivate: boolean) {
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
		isPrivate,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-07-14T00:00:00.000Z',
	}
}

test('making a package public or private requires typing the slug', async () => {
	const env = { APP_DB: {} } as Env
	const user = createUser()
	const request = new Request('https://example.com/account/packages.json', {
		method: 'POST',
	})
	mockModule.loadAccountPackagesData.mockResolvedValue({ ok: true })

	expect(
		await handleAccountPackageVisibilityAction({
			env,
			request,
			user,
			body: { action: 'delete' },
		}),
	).toBeNull()

	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage(true))
	const missingPublicConfirm = await handleAccountPackageVisibilityAction({
		env,
		request,
		user,
		body: {
			action: 'set-visibility',
			packageId: 'pkg-1',
			visibility: 'public',
		},
	})
	expect(missingPublicConfirm?.status).toBe(400)
	await expect(missingPublicConfirm?.json()).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('Type the package slug "notes"'),
	})
	expect(mockModule.publishCommunityListing).not.toHaveBeenCalled()

	const publicOk = await handleAccountPackageVisibilityAction({
		env,
		request,
		user,
		body: {
			action: 'set-visibility',
			packageId: 'pkg-1',
			visibility: 'public',
			confirmName: 'notes',
		},
	})
	expect(publicOk?.status).toBe(200)
	expect(mockModule.publishCommunityListing).toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage(false))
	const missingPrivateConfirm = await handleAccountPackageVisibilityAction({
		env,
		request,
		user,
		body: {
			action: 'set-visibility',
			packageId: 'pkg-1',
			visibility: 'private',
		},
	})
	expect(missingPrivateConfirm?.status).toBe(400)
	expect(mockModule.unpublishCommunityListing).not.toHaveBeenCalled()
})
