import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { enablePackageShareGrantsForTests } from '#worker/package-registry/share-flag.ts'
import {
	packageShareAcceptCapability,
	packageShareAcknowledgeUpdateCapability,
	packageShareInspectCapability,
	packageShareInviteCapability,
	packageShareLeaveCapability,
	packageShareListCapability,
	packageShareRevokeCapability,
} from './package-share.ts'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)
const users = {
	alice: { userId: 'aa'.repeat(32), email: 'alice@example.com' },
	jesse: { userId: 'bb'.repeat(32), email: 'jesse@example.com' },
}
type Username = keyof typeof users

async function insertUser(db: D1Database, username: Username) {
	await db
		.prepare(
			`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
			VALUES (?, ?, 'x', CURRENT_TIMESTAMP, ?, 'standard')`,
		)
		.bind(username, users[username].email, users[username].userId)
		.run()
}

function as(db: D1Database, username: Username) {
	return {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.codes',
			user: {
				...users[username],
				userId: personIdFromStored(users[username].userId),
				displayName: username,
				username,
			},
		}),
	}
}

async function createDbWithAliceSharedNotes() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const db = createD1FromSqlite(sqlite)
	await enablePackageShareGrantsForTests(db)
	await insertUser(db, 'alice')
	const packageId = crypto.randomUUID()
	const sourceId = `source-${packageId}`
	const now = new Date().toISOString()
	await insertSavedPackage(db, {
		id: packageId,
		user_id: users.alice.userId,
		name: '@alice/shared-notes',
		kody_id: 'shared-notes',
		description: 'notes',
		tags_json: '[]',
		search_text: null,
		source_id: sourceId,
		has_app: 0,
		has_skills: 0,
		hidden: 0,
		is_private: 1,
	})
	await insertEntitySource(db, {
		id: sourceId,
		user_id: users.alice.userId,
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
	return db
}

const sharedNotes = { name: '@alice/shared-notes' }

test('package share capabilities declare the package-share-grants flag', () => {
	expect(
		[
			packageShareInviteCapability,
			packageShareAcceptCapability,
			packageShareRevokeCapability,
			packageShareLeaveCapability,
			packageShareListCapability,
			packageShareInspectCapability,
			packageShareAcknowledgeUpdateCapability,
		].filter((capability) => capability.featureFlag !== 'package-share-grants'),
	).toEqual([])
})

test('packageShareInvite and packageShareAccept use pin by default', async () => {
	const db = await createDbWithAliceSharedNotes()
	await insertUser(db, 'jesse')

	const invited = await packageShareInviteCapability.handler(
		{ ...sharedNotes, username: 'jesse' },
		as(db, 'alice'),
	)
	expect(invited.grant).toMatchObject({
		status: 'pending',
		package_name: '@alice/shared-notes',
	})

	const accepted = await packageShareAcceptCapability.handler(
		sharedNotes,
		as(db, 'jesse'),
	)
	expect(accepted.grant).toMatchObject({
		status: 'accepted',
		trust_level: 'pin',
		accepted_published_commit: 'commit-1',
	})

	const listed = await packageShareListCapability.handler(
		{ scope: 'inbound' },
		as(db, 'jesse'),
	)
	expect(listed.grants).toHaveLength(1)
	expect(listed.grants[0]).toMatchObject({ status: 'accepted' })
})

test('MCP inbound list and accept-by-name see unbound verified email invites', async () => {
	const db = await createDbWithAliceSharedNotes()
	await packageShareInviteCapability.handler(
		{ ...sharedNotes, email: 'jesse@example.com' },
		as(db, 'alice'),
	)
	await insertUser(db, 'jesse')

	const listed = await packageShareListCapability.handler(
		{ scope: 'inbound' },
		as(db, 'jesse'),
	)
	expect(listed.grants).toHaveLength(1)
	expect(listed.grants[0]).toMatchObject({
		status: 'pending',
		package_name: '@alice/shared-notes',
	})

	const accepted = await packageShareAcceptCapability.handler(
		sharedNotes,
		as(db, 'jesse'),
	)
	expect(accepted.grant).toMatchObject({
		status: 'accepted',
		trust_level: 'pin',
	})
})
