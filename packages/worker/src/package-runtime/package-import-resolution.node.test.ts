import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { collectPackageStorageGrantIds } from '#mcp/run-kody-registry.ts'
import { createPlatformAccount } from '#worker/identity/platform-account-creation.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	packageScopeUsername,
	resolveSavedPackageImport,
} from './package-import-resolution.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

async function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	const platform = await createPlatformAccount({
		db,
		email: 'kody@example.com',
		username: 'kody',
	})
	return { sqlite, db, platformUserId: platform.stableUserId }
}

async function seedPackage(
	db: D1Database,
	input: {
		userId: string
		name: string
		kodyId: string
		hidden?: boolean
		isPrivate?: boolean
	},
) {
	const id = crypto.randomUUID()
	await insertSavedPackage(db, {
		id,
		user_id: input.userId,
		name: input.name,
		kody_id: input.kodyId,
		description: `${input.name} test package`,
		tags_json: '[]',
		search_text: null,
		source_id: `source-${id}`,
		has_app: 0,
		hidden: input.hidden ? 1 : 0,
		is_private: input.isPrivate ? 1 : 0,
	})
	return id
}

test('platform scopes resolve live for callers without their own copy', async () => {
	const { db, platformUserId } = await createHarness()
	const platformPackageId = await seedPackage(db, {
		userId: platformUserId,
		name: '@kody/github',
		kodyId: 'github',
	})

	const resolved = await resolveSavedPackageImport({
		db,
		userId: 'caller-user',
		specifier: 'kody:@kody/github/issues',
	})
	expect(resolved).toMatchObject({
		sourceOwnerUserId: platformUserId,
		platformScope: 'kody',
	})
	expect(resolved?.row.id).toBe(platformPackageId)
})

test('the caller-owned copy always wins over the platform scope (fork to customize)', async () => {
	const { db, platformUserId } = await createHarness()
	await seedPackage(db, {
		userId: platformUserId,
		name: '@kody/github',
		kodyId: 'github',
	})
	const ownCopyId = await seedPackage(db, {
		userId: 'caller-user',
		name: '@kody/github',
		kodyId: 'github',
	})

	const resolved = await resolveSavedPackageImport({
		db,
		userId: 'caller-user',
		specifier: 'kody:@kody/github',
	})
	expect(resolved).toMatchObject({
		sourceOwnerUserId: 'caller-user',
		platformScope: null,
	})
	expect(resolved?.row.id).toBe(ownCopyId)
})

test('hidden/private platform packages and non-platform foreign scopes do not resolve', async () => {
	const { db, platformUserId } = await createHarness()
	await seedPackage(db, {
		userId: platformUserId,
		name: '@kody/wip-package',
		kodyId: 'wip-package',
		hidden: true,
	})
	await seedPackage(db, {
		userId: platformUserId,
		name: '@kody/internal-package',
		kodyId: 'internal-package',
		isPrivate: true,
	})
	await seedPackage(db, {
		userId: 'someone-else',
		name: '@someoneelse/tools',
		kodyId: 'tools',
	})

	await expect(
		resolveSavedPackageImport({
			db,
			userId: 'caller-user',
			specifier: 'kody:@kody/wip-package',
		}),
	).resolves.toBeNull()
	await expect(
		resolveSavedPackageImport({
			db,
			userId: 'caller-user',
			specifier: 'kody:@kody/internal-package',
		}),
	).resolves.toBeNull()
	// Person-account scopes never resolve cross-user: structural, not policy.
	await expect(
		resolveSavedPackageImport({
			db,
			userId: 'caller-user',
			specifier: 'kody:@someoneelse/tools',
		}),
	).resolves.toBeNull()
})

test('allowPlatformScopes: false keeps the dynamic-import lane caller-only', async () => {
	const { db, platformUserId } = await createHarness()
	await seedPackage(db, {
		userId: platformUserId,
		name: '@kody/github',
		kodyId: 'github',
	})

	await expect(
		resolveSavedPackageImport({
			db,
			userId: 'caller-user',
			specifier: 'kody:@kody/github',
			allowPlatformScopes: false,
		}),
	).resolves.toBeNull()
})

test('packageScopeUsername parses npm scopes', () => {
	expect(packageScopeUsername('@kody/github')).toBe('kody')
	expect(packageScopeUsername('unscoped')).toBeNull()
})

test('platform-owned dependencies are excluded from packageStorage grants', () => {
	const granted = collectPackageStorageGrantIds({
		packageContext: { packageId: 'own-package-id', kodyId: 'own' } as never,
		dependencies: [
			{
				sourceId: 's1',
				publishedCommit: 'c1',
				kodyId: 'dep',
				packageId: 'own-dep-id',
			},
			{
				sourceId: 's2',
				publishedCommit: 'c2',
				kodyId: 'github',
				packageId: 'platform-dep-id',
				platformOwned: true,
			},
		],
		dynamicDependencyPackageIds: ['dynamic-dep-id'],
	})
	expect([...granted].sort()).toEqual([
		'dynamic-dep-id',
		'own-dep-id',
		'own-package-id',
	])
})
