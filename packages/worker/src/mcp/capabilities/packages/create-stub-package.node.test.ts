import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	assertWithinEntitlement: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	insertSavedPackage: vi.fn(),
	upsertSavedPackageVector: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
}))

vi.mock('#worker/entitlements/service.ts', () => ({
	assertWithinEntitlement: (...args: Array<unknown>) =>
		mockModule.assertWithinEntitlement(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: (...args: Array<unknown>) =>
		mockModule.getMcpUserPackageScope(...args),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		mockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	insertSavedPackage: (...args: Array<unknown>) =>
		mockModule.insertSavedPackage(...args),
}))

vi.mock('#worker/package-registry/vectorize.ts', () => ({
	upsertSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.upsertSavedPackageVector(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

const { createStubSavedPackage } = await import('./create-stub-package.ts')

function resetMocks() {
	for (const fn of Object.values(mockModule)) {
		fn.mockReset()
	}
	mockModule.assertWithinEntitlement.mockResolvedValue(undefined)
	mockModule.getMcpUserPackageScope.mockResolvedValue('kentcdodds')
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'source-new',
		bootstrapAccess: null,
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-1')
	mockModule.insertSavedPackage.mockResolvedValue(undefined)
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.refreshSavedPackageProjection.mockResolvedValue({ record: {} })
}

const user = {
	userId: 'user-1',
	email: 'user-1@example.com',
	displayName: 'User One',
}

test('createStubSavedPackage rejects invalid kody ids and registers valid stubs through the pipeline', async () => {
	resetMocks()
	await expect(
		createStubSavedPackage({
			env: { APP_DB: {} } as Env,
			baseUrl: 'https://heykody.dev',
			user,
			kodyId: 'Not_A_Valid_Id',
		}),
	).rejects.toThrow(/lower-kebab-case/)
	expect(mockModule.assertWithinEntitlement).not.toHaveBeenCalled()
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()

	resetMocks()
	const result = await createStubSavedPackage({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://heykody.dev',
		user,
		kodyId: 'my-package',
		description: 'Does the thing.',
	})
	expect(result).toMatchObject({
		kodyId: 'my-package',
		name: '@kentcdodds/my-package',
	})
	expect(mockModule.assertWithinEntitlement).toHaveBeenCalledWith(
		expect.objectContaining({ resource: 'saved_packages' }),
	)
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-new',
			userId: 'user-1',
			files: expect.objectContaining({
				'package.json': expect.stringContaining('"private": true'),
				'README.md': expect.stringContaining('## Intent'),
			}),
		}),
	)
	expect(mockModule.insertSavedPackage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			name: '@kentcdodds/my-package',
			kody_id: 'my-package',
			description: 'Does the thing.',
			source_id: 'source-new',
			has_app: 0,
			hidden: 0,
		}),
	)
	expect(mockModule.upsertSavedPackageVector).toHaveBeenCalled()
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalled()
})
