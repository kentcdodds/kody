import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	listPublicProfilePackages,
	listPublicProfileRepos,
} from './profile-repo.ts'

const ownerId = 'person-owner'
const now = '2026-01-01T00:00:00.000Z'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, 'owner', 'Owner', ?, ?)`,
		)
		.run(ownerId, now, now)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id, is_private, hidden,
				created_at, updated_at
			) VALUES (?, ?, '@owner/notes', 'notes', 'pkg', 'src-1', 0, 0, ?, ?)`,
		)
		.run('pkg-1', ownerId, now, '2026-02-01T00:00:00.000Z')
	sqlite
		.prepare(
			`INSERT INTO user_repos (
				id, user_id, name, description, is_private, created_at, updated_at
			) VALUES (?, ?, 'stash-files', 'plain', 1, ?, ?)`,
		)
		.run('repo-1', ownerId, now, '2026-03-01T00:00:00.000Z')
	sqlite
		.prepare(
			`INSERT INTO user_repos (
				id, user_id, name, description, is_private, created_at, updated_at
			) VALUES (?, ?, 'public-docs', 'public plain', 0, ?, ?)`,
		)
		.run('repo-2', ownerId, now, '2026-01-15T00:00:00.000Z')
	return createD1FromSqlite(sqlite)
}

test('listPublicProfileRepos returns plain repos with hasPackage false', async () => {
	const db = createDb()
	const own = await listPublicProfileRepos(db, {
		ownerStableUserId: ownerId,
		ownerUsername: 'owner',
		includePrivate: true,
	})
	expect(own.map((repo) => repo.kodyId).sort()).toEqual([
		'public-docs',
		'stash-files',
	])
	expect(own.every((repo) => repo.hasPackage === false)).toBe(true)
	expect(own.find((repo) => repo.kodyId === 'stash-files')).toMatchObject({
		name: '@owner/stash-files',
		isPrivate: true,
		packageId: 'repo-1',
	})

	const publicOnly = await listPublicProfileRepos(db, {
		ownerStableUserId: ownerId,
		ownerUsername: 'owner',
		includePrivate: false,
	})
	expect(publicOnly.map((repo) => repo.kodyId)).toEqual(['public-docs'])
})

test('packages and plain repos stay distinct inventories', async () => {
	const db = createDb()
	const packages = await listPublicProfilePackages(db, {
		ownerStableUserId: ownerId,
		includePrivate: true,
	})
	const repos = await listPublicProfileRepos(db, {
		ownerStableUserId: ownerId,
		ownerUsername: 'owner',
		includePrivate: true,
	})
	expect(packages.every((pkg) => pkg.hasPackage)).toBe(true)
	expect(repos.every((repo) => !repo.hasPackage)).toBe(true)
	expect(packages.map((pkg) => pkg.kodyId)).toEqual(['notes'])
	expect(repos.map((repo) => repo.kodyId).sort()).toEqual([
		'public-docs',
		'stash-files',
	])
})

test('capped plain-repo search matches @owner/leaf as well as the bare name', async () => {
	const db = createDb()
	const byScoped = await listPublicProfileRepos(db, {
		ownerStableUserId: ownerId,
		ownerUsername: 'owner',
		query: '@owner/public-docs',
		includePrivate: true,
		limit: 5,
	})
	expect(byScoped.map((repo) => repo.kodyId)).toEqual(['public-docs'])

	const byLeaf = await listPublicProfileRepos(db, {
		ownerStableUserId: ownerId,
		ownerUsername: 'owner',
		query: 'stash-files',
		includePrivate: true,
		limit: 5,
	})
	expect(byLeaf.map((repo) => repo.kodyId)).toEqual(['stash-files'])
})
