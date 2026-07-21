import { expect, test, vi } from 'vitest'
import { type PackageOwnerContext } from '#worker/package-registry/package-owner.ts'

const mockModule = vi.hoisted(() => ({
	assertWithinEntitlement: vi.fn(),
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
	mockModule.ensureEntitySource.mockResolvedValue({
		id: 'source-new',
		bootstrapAccess: null,
	})
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('commit-1')
	mockModule.insertSavedPackage.mockResolvedValue(undefined)
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.refreshSavedPackageProjection.mockResolvedValue({ record: {} })
}

const owner: PackageOwnerContext = {
	ownerUserId: 'user-1',
	ownerScope: 'kentcdodds',
	ownerEmail: 'user-1@example.com',
	actorUserId: 'user-1',
	delegated: false,
}

test('createStubSavedPackage rejects invalid kody ids and registers stubs for owner and delegated scopes', async () => {
	resetMocks()
	await expect(
		createStubSavedPackage({
			env: { APP_DB: {} } as Env,
			baseUrl: 'https://heykody.dev',
			owner,
			kodyId: 'Not_A_Valid_Id',
		}),
	).rejects.toThrow(/lower-kebab-case/)
	expect(mockModule.assertWithinEntitlement).not.toHaveBeenCalled()
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()

	resetMocks()
	const result = await createStubSavedPackage({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://heykody.dev',
		owner,
		kodyId: 'my-package',
		description: 'Does the thing.',
	})
	expect(result).toMatchObject({
		kodyId: 'my-package',
		name: '@kentcdodds/my-package',
	})
	expect(mockModule.assertWithinEntitlement).toHaveBeenCalledWith(
		expect.objectContaining({
			resource: 'saved_packages',
			userId: 'user-1',
			email: 'user-1@example.com',
		}),
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
			user_id: 'user-1',
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

	// Delegated grants must persist under the platform owner, not the actor.
	resetMocks()
	const delegatedOwner: PackageOwnerContext = {
		ownerUserId: 'platform-owner',
		ownerScope: 'kody',
		ownerEmail: 'kody@example.com',
		actorUserId: 'actor-1',
		delegated: true,
	}
	await createStubSavedPackage({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://heykody.dev',
		owner: delegatedOwner,
		kodyId: 'official-tool',
	})
	expect(mockModule.assertWithinEntitlement).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'platform-owner',
			email: 'kody@example.com',
		}),
	)
	expect(mockModule.ensureEntitySource).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'platform-owner' }),
	)
	expect(mockModule.insertSavedPackage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			user_id: 'platform-owner',
			name: '@kody/official-tool',
		}),
	)
	expect(mockModule.upsertSavedPackageVector).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ userId: 'platform-owner' }),
	)
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'platform-owner' }),
	)
})
