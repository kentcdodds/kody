import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceByIdForUser: vi.fn(),
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

const { resolveRepoSourceReference } = await import('./repo-resolve-target.ts')

test('resolveRepoSourceReference throws McpCallerError for missing source and package', async () => {
	mockModule.getEntitySourceByIdForUser.mockReset()
	mockModule.getSavedPackageById.mockReset()
	mockModule.getSavedPackageByKodyId.mockReset()

	mockModule.getEntitySourceByIdForUser.mockResolvedValue(null)
	const missingSource = resolveRepoSourceReference({
		db: {} as D1Database,
		userId: 'user-1',
		args: { source_id: 'source-missing' },
	})

	await expect(missingSource).rejects.toThrow(McpCallerError)
	await expect(missingSource).rejects.toThrow(
		'Repo source was not found for this user.',
	)
	// The user predicate belongs in the query, not in a post-read comparison.
	expect(mockModule.getEntitySourceByIdForUser).toHaveBeenCalledWith(
		expect.anything(),
		{ id: 'source-missing', userId: 'user-1' },
	)

	mockModule.getSavedPackageById.mockResolvedValue(null)
	const missingPackage = resolveRepoSourceReference({
		db: {} as D1Database,
		userId: 'user-1',
		args: { target: { kind: 'package', package_id: 'pkg-missing' } },
	})

	await expect(missingPackage).rejects.toThrow(McpCallerError)
	await expect(missingPackage).rejects.toThrow(
		'Saved package "pkg-missing" was not found.',
	)

	const missingIdentity = resolveRepoSourceReference({
		db: {} as D1Database,
		userId: 'user-1',
		args: {},
	})

	await expect(missingIdentity).rejects.toThrow(McpCallerError)
	await expect(missingIdentity).rejects.toThrow(
		'Repo source identity is required.',
	)
})

test('resolveRepoSourceReference looks up scoped package names by leaf', async () => {
	mockModule.getEntitySourceByIdForUser.mockReset()
	mockModule.getSavedPackageById.mockReset()
	mockModule.getSavedPackageByKodyId.mockReset()

	const savedPackage = {
		id: 'pkg-1',
		kodyId: 'package-app-kit',
		name: '@me/package-app-kit',
		sourceId: 'source-1',
	}
	const source = {
		id: 'source-1',
		entity_kind: 'package',
		entity_id: 'pkg-1',
	}
	mockModule.getSavedPackageByKodyId.mockResolvedValue(savedPackage)
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(source)

	const resolved = await resolveRepoSourceReference({
		db: {} as D1Database,
		userId: 'user-1',
		args: {
			target: { kind: 'package', kody_id: '@me/package-app-kit' },
		},
	})

	expect(mockModule.getSavedPackageByKodyId).toHaveBeenCalledWith(
		expect.anything(),
		{ userId: 'user-1', kodyId: 'package-app-kit' },
	)
	expect(resolved).toEqual({
		source,
		resolvedTarget: {
			kind: 'package',
			source_id: 'source-1',
			package_id: 'pkg-1',
			kody_id: 'package-app-kit',
			name: '@me/package-app-kit',
		},
	})
})
