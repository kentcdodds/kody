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

test('createStubSavedPackage accepts a leaf or matching scoped name and rejects a foreign scope', async () => {
	resetMocks()
	await expect(
		createStubSavedPackage({
			env: { APP_DB: {} } as Env,
			baseUrl: 'https://heykody.dev',
			owner,
			packageName: 'Not_A_Valid_Id',
		}),
	).rejects.toThrow(/lower-kebab-case package name leaf/)
	expect(mockModule.assertWithinEntitlement).not.toHaveBeenCalled()
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()

	resetMocks()
	await expect(
		createStubSavedPackage({
			env: { APP_DB: {} } as Env,
			baseUrl: 'https://heykody.dev',
			owner,
			packageName: '@other/my-package',
		}),
	).rejects.toThrow(/does not match the acting owner "@kentcdodds"/)
	expect(mockModule.assertWithinEntitlement).not.toHaveBeenCalled()

	resetMocks()
	const result = await createStubSavedPackage({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://heykody.dev',
		owner,
		packageName: 'my-package',
		description: 'Does the thing.',
	})
	expect(result).toMatchObject({
		packageName: 'my-package',
		name: '@kentcdodds/my-package',
	})
	expect(mockModule.assertWithinEntitlement).toHaveBeenCalledWith(
		expect.objectContaining({
			resource: 'saved_packages',
			userId: 'user-1',
			email: 'user-1@example.com',
		}),
	)
	const leafFiles = mockModule.syncArtifactSourceSnapshot.mock.calls[0]?.[0]
		.files as Record<string, string>
	expect(leafFiles['package.json']).toContain(
		'"name": "@kentcdodds/my-package"',
	)
	expect(leafFiles['package.json']).not.toContain('"id":')
	expect(leafFiles['package.json']).toContain('"private": true')
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
			is_private: 1,
		}),
	)

	resetMocks()
	const scopedResult = await createStubSavedPackage({
		env: { APP_DB: {} } as Env,
		baseUrl: 'https://heykody.dev',
		owner,
		packageName: '@kentcdodds/mailchimp',
	})
	expect(scopedResult).toMatchObject({
		packageName: 'mailchimp',
		name: '@kentcdodds/mailchimp',
	})
	expect(mockModule.insertSavedPackage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			name: '@kentcdodds/mailchimp',
			kody_id: 'mailchimp',
		}),
	)

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
		packageName: 'official-tool',
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
