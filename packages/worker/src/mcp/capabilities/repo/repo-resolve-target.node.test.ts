import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { mismatchedPackageScopeMessage } from '#worker/package-registry/package-name.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceByIdForUser: vi.fn(),
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
}))

const { resolveRepoSourceReference } = await import('./repo-resolve-target.ts')

function createSavedPackageRow() {
	return {
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		name: '@kentcdodds/travel-map',
		kodyId: 'travel-map',
		description: 'Travel map',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		createdAt: '2026-09-14T00:00:00.000Z',
		updatedAt: '2026-09-14T00:00:00.000Z',
	}
}

function createPackageSourceRow() {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-09-14T00:00:00.000Z',
		updated_at: '2026-09-14T00:00:00.000Z',
	}
}

function resetMocks() {
	for (const fn of Object.values(mockModule)) fn.mockReset()
}

function resolve(
	args: Parameters<typeof resolveRepoSourceReference>[0]['args'],
	ownerScope?: string,
) {
	return resolveRepoSourceReference({
		db: {} as D1Database,
		userId: ownerIdFromStored('user-1'),
		ownerScope,
		args,
	})
}

async function expectCallerError(promise: Promise<unknown>, message: string) {
	const error = await promise.catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).toHaveProperty('message', message)
}

test('resolveRepoSourceReference throws McpCallerError for missing source and package', async () => {
	resetMocks()
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(null)
	mockModule.getSavedPackageById.mockResolvedValue(null)

	await expectCallerError(
		resolve({ source_id: 'source-missing' }),
		'Repo source was not found for this user.',
	)
	// The user predicate belongs in the query, not in a post-read comparison.
	expect(mockModule.getEntitySourceByIdForUser).toHaveBeenCalledWith(
		expect.anything(),
		{ id: 'source-missing', userId: ownerIdFromStored('user-1') },
	)
	await expectCallerError(
		resolve({ target: { kind: 'package', package_id: 'pkg-missing' } }),
		'Saved package "pkg-missing" was not found.',
	)
	await expectCallerError(resolve({}), 'Repo source identity is required.')
})

test('resolveRepoSourceReference accepts scoped @owner/leaf, leaf-only, and rejects unknown scoped names', async () => {
	resetMocks()
	const savedPackage = createSavedPackageRow()
	const source = createPackageSourceRow()
	mockModule.resolveSavedPackageRef.mockImplementation(
		async (_db: D1Database, input: { ref: string }) =>
			input.ref === 'travel-map' ? savedPackage : null,
	)
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(source)

	const scoped = await resolve(
		{ target: { kind: 'package', kody_id: '@kentcdodds/travel-map' } },
		'kentcdodds',
	)
	const leaf = await resolve(
		{ target: { kind: 'package', kody_id: 'travel-map' } },
		'kentcdodds',
	)

	expect(scoped.resolvedTarget).toEqual({
		kind: 'package',
		source_id: 'source-1',
		package_id: 'package-1',
		kody_id: 'travel-map',
		name: '@kentcdodds/travel-map',
	})
	expect(leaf.resolvedTarget).toEqual(scoped.resolvedTarget)
	expect(scoped.source).toEqual(source)
	expect(mockModule.resolveSavedPackageRef.mock.calls).toEqual([
		[
			expect.anything(),
			{ userId: ownerIdFromStored('user-1'), ref: 'travel-map', match: 'slug' },
		],
		[
			expect.anything(),
			{ userId: ownerIdFromStored('user-1'), ref: 'travel-map', match: 'slug' },
		],
	])

	await expectCallerError(
		resolve(
			{ target: { kind: 'package', kody_id: '@kentcdodds/does-not-exist' } },
			'kentcdodds',
		),
		'Saved package "@kentcdodds/does-not-exist" was not found.',
	)
	expect(mockModule.resolveSavedPackageRef).toHaveBeenLastCalledWith(
		expect.anything(),
		{
			userId: ownerIdFromStored('user-1'),
			ref: 'does-not-exist',
			match: 'slug',
		},
	)

	await expectCallerError(
		resolve(
			{ target: { kind: 'package', kody_id: '@other/travel-map' } },
			'kentcdodds',
		),
		mismatchedPackageScopeMessage({
			value: '@other/travel-map',
			requestedScope: 'other',
			ownerScope: 'kentcdodds',
		}),
	)
	expect(mockModule.resolveSavedPackageRef).toHaveBeenCalledTimes(3)
})
