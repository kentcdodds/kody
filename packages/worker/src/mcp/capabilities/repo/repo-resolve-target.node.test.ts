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
