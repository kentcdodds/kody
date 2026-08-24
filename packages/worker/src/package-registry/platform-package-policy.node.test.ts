import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createPlatformAccount } from '#worker/identity/platform-account-creation.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	assertPersonOwnedPackageMayNotRunPlatformDependencies,
	collectScopedPackageNamesFromSource,
	findPersonPackagePlatformReference,
	personPackagePlatformDependencyMessage,
	rewriteForkedPackageSelfReferences,
	throwIfPersonPackagePlatformReference,
} from './platform-package-policy.ts'

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
	return { db, platformUserId: platform.stableUserId }
}

async function seedPackage(
	db: D1Database,
	input: { userId: string; name: string; kodyId: string },
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
		hidden: 0,
		is_private: 0,
	})
	return id
}

test('collectScopedPackageNamesFromSource reads imports, deps, and invoke specifiers', () => {
	expect(
		collectScopedPackageNamesFromSource({
			manifestDependencies: { '@kody/github': '*', '@alice/helper': '*' },
			sourceFiles: {
				'index.ts': `
import gh from 'kody:@kody/github/issues'
import helper from 'kody:@alice/helper'
await packages.invoke('kody:@kody/notion/smoke-test', { params: {} })
await packages.invoke('@kody/google/profile', { params: {} })
`,
			},
		}),
	).toEqual(['@alice/helper', '@kody/github', '@kody/google', '@kody/notion'])
})

test('findPersonPackagePlatformReference names the official package and ignores person scopes', async () => {
	const { db } = await createHarness()
	await expect(
		findPersonPackagePlatformReference({
			db,
			manifestDependencies: { '@alice/helper': '*' },
			sourceFiles: {
				'index.ts': `import helper from 'kody:@alice/helper'\n`,
			},
		}),
	).resolves.toBeNull()
	await expect(
		findPersonPackagePlatformReference({
			db,
			sourceFiles: {
				'job.ts': `await packages.invoke('kody:@kody/notion/smoke-test')\n`,
			},
		}),
	).resolves.toBe('@kody/notion')
	await expect(
		throwIfPersonPackagePlatformReference({
			db,
			packageName: '@alice/helper',
		}),
	).resolves.toBeUndefined()
	await expect(
		throwIfPersonPackagePlatformReference({
			db,
			packageName: '@kody/notion',
		}),
	).rejects.toThrow(personPackagePlatformDependencyMessage)
})

test('rewriteForkedPackageSelfReferences rewrites only the forked package name', () => {
	const files = rewriteForkedPackageSelfReferences({
		files: {
			'package.json':
				'{"dependencies":{"@kody/github":"*","@kody/shared":"*"}}',
			'index.ts': `import gh from 'kody:@kody/github/issues'
import shared from 'kody:@kody/shared/util'
`,
		},
		originPackageName: '@kody/github',
		nextPackageName: '@alice/github',
	})
	expect(files['index.ts']).toContain('kody:@alice/github/issues')
	expect(files['index.ts']).toContain('kody:@kody/shared/util')
	expect(files['package.json']).toContain('"@alice/github"')
	expect(files['package.json']).toContain('"@kody/shared"')

	const templateLiteral = rewriteForkedPackageSelfReferences({
		files: {
			'job.ts': 'await packages.invoke(`kody:@kody/github/issues`)\n',
		},
		originPackageName: '@kody/github',
		nextPackageName: '@alice/github',
	})
	expect(templateLiteral['job.ts']).toContain('kody:@alice/github/issues')
})

test('already-published person artifacts with platformOwned deps fail closed; platform composers do not', async () => {
	const { db, platformUserId } = await createHarness()
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			VALUES (?, ?, 'x', CURRENT_TIMESTAMP, ?, 'free')`,
		)
		.bind('alice', 'alice@example.com', 'person-alice')
		.run()
	const personPackageId = await seedPackage(db, {
		userId: 'person-alice',
		name: '@alice/helper',
		kodyId: 'helper',
	})
	const platformPackageId = await seedPackage(db, {
		userId: platformUserId,
		name: '@kody/github',
		kodyId: 'github',
	})
	const platformOwned = [{ platformOwned: true }]

	await expect(
		assertPersonOwnedPackageMayNotRunPlatformDependencies({
			db,
			userId: 'person-alice',
			packageId: personPackageId,
			dependencies: platformOwned,
		}),
	).rejects.toThrow(personPackagePlatformDependencyMessage)
	await expect(
		assertPersonOwnedPackageMayNotRunPlatformDependencies({
			db,
			userId: platformUserId,
			packageId: platformPackageId,
			dependencies: platformOwned,
		}),
	).resolves.toBeUndefined()
	await expect(
		assertPersonOwnedPackageMayNotRunPlatformDependencies({
			db,
			userId: 'person-alice',
			packageId: personPackageId,
			dependencies: [{ platformOwned: false }],
		}),
	).resolves.toBeUndefined()
	await expect(
		assertPersonOwnedPackageMayNotRunPlatformDependencies({
			db,
			userId: 'person-alice',
			packageId: platformPackageId,
			dependencies: platformOwned,
		}),
	).resolves.toBeUndefined()
})
