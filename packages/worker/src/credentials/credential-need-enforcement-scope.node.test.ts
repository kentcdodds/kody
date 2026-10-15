import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { selectCredentialNeedEnforcementScope } from './credential-need-enforcement-scope.ts'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

async function insertPerson(db: D1Database, personalOrgId: string) {
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			VALUES (?, ?, 'hash', ?)`,
		)
		.bind(personalOrgId, `${personalOrgId}@example.com`, personalOrgId)
		.run()
}

async function insertGrant(
	db: D1Database,
	input: { orgId: string; deletedAt?: string },
) {
	await db
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, ?, 'package', 'pkg', 'user', 'friend', 'use', ?, ?, ?, ?)`,
		)
		.bind(
			crypto.randomUUID(),
			input.orgId,
			input.orgId,
			'2026-10-15T00:00:00.000Z',
			'2026-10-15T00:00:00.000Z',
			input.deletedAt ?? null,
		)
		.run()
}

async function insertFork(
	db: D1Database,
	input: { packageId: string; forker: string; adoptedAt?: string },
) {
	await db
		.prepare(
			`INSERT INTO community_forks (
				id, listing_id, forker_user_id, origin_commit, forked_package_id,
				forked_source_id, target_kody_id, adopted_at
			) VALUES (?, 'listing', ?, 'origin', ?, 'source', 'forked', ?)`,
		)
		.bind(
			crypto.randomUUID(),
			input.forker,
			input.packageId,
			input.adoptedAt ?? null,
		)
		.run()
}

function pkg(id: string, userId: string, isInternetVisible = false) {
	return { id, userId, isInternetVisible } as Parameters<
		typeof selectCredentialNeedEnforcementScope
	>[1][number]
}

test('scope keeps packages someone other than their author may run', async () => {
	const db = createDb()
	for (const org of ['solo', 'sharer', 'forker', 'adopter', 'revoked']) {
		await insertPerson(db, org)
	}
	await insertGrant(db, { orgId: 'sharer' })
	await insertGrant(db, {
		orgId: 'revoked',
		deletedAt: '2026-10-15T01:00:00.000Z',
	})
	await insertFork(db, { packageId: 'pkg-fork', forker: 'forker' })
	await insertFork(db, {
		packageId: 'pkg-adopted',
		forker: 'adopter',
		adoptedAt: '2026-10-15T01:00:00.000Z',
	})

	const selected = await selectCredentialNeedEnforcementScope(db, [
		pkg('pkg-solo', 'solo'),
		pkg('pkg-solo-public', 'solo', true),
		pkg('pkg-team', 'team-org'),
		pkg('pkg-shared', 'sharer'),
		pkg('pkg-revoked', 'revoked'),
		pkg('pkg-fork', 'forker'),
		pkg('pkg-adopted', 'adopter'),
	])

	expect(selected.map((entry) => entry.id)).toEqual([
		'pkg-solo-public',
		'pkg-team',
		'pkg-shared',
		'pkg-fork',
	])
	expect(await selectCredentialNeedEnforcementScope(db, [])).toEqual([])
})
