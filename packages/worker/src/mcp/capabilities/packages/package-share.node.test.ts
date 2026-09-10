import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	packageShareAcceptCapability,
	packageShareInviteCapability,
	packageShareListCapability,
} from './package-share.ts'

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)
const ownerUserId = 'aa'.repeat(32)
const guestUserId = 'bb'.repeat(32)

async function insertUser(
	db: D1Database,
	input: { username: string; email: string; userId: string },
) {
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			VALUES (?, ?, 'x', CURRENT_TIMESTAMP, ?, 'standard')`,
		)
		.bind(input.username, input.email, input.userId)
		.run()
}

function callerContext(input: {
	db: D1Database
	userId: string
	email: string
	username: string
}) {
	return {
		env: { APP_DB: input.db } as Env,
		callerContext: {
			baseUrl: 'https://kody.codes',
			user: {
				userId: input.userId,
				email: input.email,
				displayName: input.username,
				username: input.username,
			},
			storageContext: null,
			repoContext: null,
		},
	}
}

test('packageShareInvite and packageShareAccept use pin by default', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await insertUser(db, {
		username: 'alice',
		email: 'alice@example.com',
		userId: ownerUserId,
	})
	await insertUser(db, {
		username: 'jesse',
		email: 'jesse@example.com',
		userId: guestUserId,
	})
	const packageId = crypto.randomUUID()
	const sourceId = `source-${packageId}`
	const now = new Date().toISOString()
	await insertSavedPackage(db, {
		id: packageId,
		user_id: ownerUserId,
		name: '@alice/shared-notes',
		kody_id: 'shared-notes',
		description: 'notes',
		tags_json: '[]',
		search_text: null,
		source_id: sourceId,
		has_app: 0,
		hidden: 0,
		is_private: 1,
	})
	await insertEntitySource(db, {
		id: sourceId,
		user_id: ownerUserId,
		entity_kind: 'package',
		entity_id: packageId,
		repo_id: `repo-${sourceId}`,
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	})

	const invited = await packageShareInviteCapability.handler(
		{ name: '@alice/shared-notes', username: 'jesse' },
		callerContext({
			db,
			userId: ownerUserId,
			email: 'alice@example.com',
			username: 'alice',
		}),
	)
	expect(invited.grant).toMatchObject({
		status: 'pending',
		package_name: '@alice/shared-notes',
	})

	const accepted = await packageShareAcceptCapability.handler(
		{ name: '@alice/shared-notes' },
		callerContext({
			db,
			userId: guestUserId,
			email: 'jesse@example.com',
			username: 'jesse',
		}),
	)
	expect(accepted.grant).toMatchObject({
		status: 'accepted',
		trust_level: 'pin',
		accepted_published_commit: 'commit-1',
	})

	const listed = await packageShareListCapability.handler(
		{ scope: 'inbound' },
		callerContext({
			db,
			userId: guestUserId,
			email: 'jesse@example.com',
			username: 'jesse',
		}),
	)
	expect(listed.grants).toHaveLength(1)
	expect(listed.grants[0]).toMatchObject({ status: 'accepted' })
})
