import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { runWithRequestPermissions } from '#worker/authorization/authorize.ts'
import { collectPackageStorageGrantIds } from '#mcp/run-kody-registry.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import {
	resolveSavedPackageImport,
	SavedPackageNotFoundError,
} from './package-import-resolution.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	return { db: createD1FromSqlite(sqlite) }
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
		user_id: ownerIdFromStored(input.userId),
		name: input.name,
		kody_id: input.kodyId,
		description: `${input.name} test package`,
		tags_json: '[]',
		search_text: null,
		source_id: `source-${id}`,
		has_app: 0,
		has_skills: 0,
		hidden: input.hidden ? 1 : 0,
		is_private: input.isPrivate ? 1 : 0,
	})
	return id
}

function resolve(db: D1Database, userId: string, specifier: string) {
	return resolveSavedPackageImport({ db, userId, specifier })
}

test("resolveSavedPackageImport resolves only the caller's own org packages", async () => {
	const { db } = createHarness()
	const ownId = await seedPackage(db, {
		userId: ownerIdFromStored('caller-user'),
		name: '@caller/github',
		kodyId: 'github',
	})
	await seedPackage(db, {
		userId: ownerIdFromStored('kody-org'),
		name: '@kody/github',
		kodyId: 'github',
	})
	await seedPackage(db, {
		userId: ownerIdFromStored('someone-else'),
		name: '@someoneelse/tools',
		kodyId: 'tools',
	})

	const own = await resolve(db, 'caller-user', 'kody:@caller/github/issues')
	expect(own?.row.id).toBe(ownId)
	for (const specifier of [
		'kody:@kody/github/issues',
		'kody:@someoneelse/tools',
	]) {
		await expect(resolve(db, 'caller-user', specifier)).resolves.toBeNull()
	}
	expect(new SavedPackageNotFoundError('@kody/github').message).toContain(
		'communityFork it into this org',
	)
})

test("an import resolved under another org's storage is wrong_org for the bound request", async () => {
	const { db } = createHarness()
	await seedPackage(db, {
		userId: ownerIdFromStored('caller-user'),
		name: '@caller/notes',
		kodyId: 'notes',
	})
	await seedPackage(db, {
		userId: ownerIdFromStored('other-org'),
		name: '@other/notes',
		kodyId: 'notes',
	})
	const env = { APP_DB: db } as Env
	const request = sessionRequestContext('caller-user')

	const [own, foreign] = await runWithRequestPermissions(
		{ env, request },
		async () =>
			await Promise.all([
				resolve(db, 'caller-user', 'kody:@caller/notes'),
				resolve(db, 'other-org', 'kody:@other/notes'),
			]),
	)
	expect(own?.row.name).toBe('@caller/notes')
	expect(foreign).toBeNull()
})

test('every bundle dependency id joins the packageStorage grant set', () => {
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
				kodyId: 'nested',
				packageId: 'transitive-dep-id',
				transitive: true,
			},
		],
		dynamicDependencyPackageIds: ['dynamic-dep-id'],
	})
	expect([...granted].sort()).toEqual([
		'dynamic-dep-id',
		'own-dep-id',
		'own-package-id',
		'transitive-dep-id',
	])
})
