import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createPlatformAccount } from '#worker/identity/platform-account-creation.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	collectScopedPackageNamesFromSource,
	findPersonPackagePlatformReference,
	formatPersonPackagePlatformDependencyMessage,
	personPackagePlatformDependencyMessage,
	rewriteForkedPackageSelfReferences,
	throwIfPersonPackagePlatformReference,
} from './platform-package-policy.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)

async function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await createPlatformAccount({
		db,
		email: 'kody@example.com',
		username: 'kody',
	})
	return { db }
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
	expect(
		formatPersonPackagePlatformDependencyMessage('@kody/notion'),
	).toContain(personPackagePlatformDependencyMessage)
	expect(
		formatPersonPackagePlatformDependencyMessage('@kody/notion'),
	).toContain('@kody/notion')
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
