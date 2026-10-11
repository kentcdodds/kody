import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0110-credential-ids-and-grants.sql'
const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function databaseBeforeMigration() {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: false,
	})
	for (const name of readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql') && name < migrationFileName)
		.sort()) {
		sqlite.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
	sqlite.exec(`
		INSERT INTO orgs (id, slug, access_epoch, created_at, updated_at) VALUES
			('org-a', 'org-a', 3, '2026-10-01', '2026-10-01'),
			('org-b', 'org-b', 7, '2026-10-01', '2026-10-01');
		INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES
			('bucket-a', 'org-a', 'user', ''),
			('bucket-a-pkg', 'org-a', 'package', 'pkg-1');
		INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES
			('bucket-a', 'OPENAI_KEY', 'ct'),
			('bucket-a', 'VAULT_DOOR', 'ct'),
			('bucket-a-pkg', 'PKG_ONLY', 'ct');
		INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
		VALUES ('org-a', 'github', 'github', 'client', 'https://github.com/token', 'confidential');
		INSERT INTO user_integrations (user_id, name, app_slug, access_token_encrypted)
		VALUES ('org-a', 'github', 'github', 'ct');
		INSERT INTO mcp_server_settings (id, user_id, name, url)
		VALUES ('mcp-linear', 'org-a', 'linear', 'https://mcp.linear.app');
		INSERT INTO secret_provider_bindings (user_id, provider_id, package_id, door_secret_name)
		VALUES ('org-a', '1password', 'pkg-op', 'VAULT_DOOR');
	`)
	return sqlite
}

function insertGrant(
	sqlite: DatabaseSync,
	grant: {
		id: string
		resourceType: string
		resourceId: string
		deletedAt?: string
		permissions: Array<string>
	},
) {
	sqlite
		.prepare(
			`INSERT INTO grants (
				id, org_id, resource_type, resource_id, subject_type, subject_id,
				preset, created_by_user_id, created_at, updated_at, deleted_at
			) VALUES (?, 'org-a', ?, ?, 'user', 'carol', 'use', 'alice', '2026-10-01', '2026-10-01', ?)`,
		)
		.run(
			grant.id,
			grant.resourceType,
			grant.resourceId,
			grant.deletedAt ?? null,
		)
	for (const permission of grant.permissions) {
		sqlite
			.prepare(
				`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
			)
			.run(grant.id, permission)
	}
}

function insertInvite(
	sqlite: DatabaseSync,
	invite: { id: string; resourceType: string; resourceId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO invites (
				id, org_id, kind, resource_type, resource_id, preset, invitee_username,
				token_hash, status, invited_by_user_id, expires_at, created_at
			) VALUES (?, 'org-a', 'grant', ?, ?, 'use', 'carol', ?, 'pending', 'alice', '2026-10-08', '2026-10-01')`,
		)
		.run(invite.id, invite.resourceType, invite.resourceId, `hash-${invite.id}`)
}

function runMigration(sqlite: DatabaseSync) {
	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)
}

function idOf(sqlite: DatabaseSync, sql: string) {
	const row = sqlite.prepare(sql).get() as { id: string } | undefined
	if (!row) throw new Error(`No row for ${sql}`)
	return row.id
}

test('0110 gives credential rows ids and moves name-keyed grants and invites onto them', () => {
	const sqlite = databaseBeforeMigration()
	insertGrant(sqlite, {
		id: 'grant-secret',
		resourceType: 'secret',
		resourceId: 'OPENAI_KEY',
		permissions: ['secret:use'],
	})
	insertGrant(sqlite, {
		id: 'grant-secret-revoked',
		resourceType: 'secret',
		resourceId: 'OPENAI_KEY',
		deletedAt: '2026-10-02',
		permissions: ['secret:use'],
	})
	insertGrant(sqlite, {
		id: 'grant-integration',
		resourceType: 'integration',
		resourceId: 'github',
		permissions: ['integration:read', 'integration:use'],
	})
	insertGrant(sqlite, {
		id: 'grant-mcp',
		resourceType: 'integration',
		resourceId: 'linear',
		permissions: ['integration:read', 'integration:use'],
	})
	insertGrant(sqlite, {
		id: 'grant-package',
		resourceType: 'package',
		resourceId: 'pkg-1',
		permissions: ['package:execute', 'package:read'],
	})
	insertInvite(sqlite, {
		id: 'invite-integration',
		resourceType: 'integration',
		resourceId: 'github',
	})

	runMigration(sqlite)

	const secretId = idOf(
		sqlite,
		`SELECT id FROM secret_entries WHERE name = 'OPENAI_KEY'`,
	)
	const integrationId = idOf(
		sqlite,
		`SELECT id FROM user_integrations WHERE name = 'github'`,
	)
	const bindingId = idOf(sqlite, `SELECT id FROM secret_provider_bindings`)
	for (const id of [secretId, integrationId, bindingId]) {
		expect(id).toMatch(uuidPattern)
	}
	expect(
		sqlite
			.prepare(`SELECT COUNT(*) AS count FROM secret_entries WHERE id IS NULL`)
			.get(),
	).toEqual({ count: 0 })

	expect(
		sqlite
			.prepare(
				`SELECT id, resource_type, resource_id, deleted_at FROM grants ORDER BY id`,
			)
			.all(),
	).toEqual([
		{
			id: 'grant-integration',
			resource_type: 'credential',
			resource_id: integrationId,
			deleted_at: null,
		},
		{
			id: 'grant-mcp',
			resource_type: 'credential',
			resource_id: 'mcp-linear',
			deleted_at: null,
		},
		{
			id: 'grant-package',
			resource_type: 'package',
			resource_id: 'pkg-1',
			deleted_at: null,
		},
		{
			id: 'grant-secret',
			resource_type: 'credential',
			resource_id: secretId,
			deleted_at: null,
		},
		{
			id: 'grant-secret-revoked',
			resource_type: 'credential',
			resource_id: secretId,
			deleted_at: '2026-10-02',
		},
	])
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM grant_permissions`).get(),
	).toEqual({ count: 8 })
	expect(
		sqlite.prepare(`SELECT resource_type, resource_id FROM invites`).get(),
	).toEqual({ resource_type: 'credential', resource_id: integrationId })
	expect(
		sqlite.prepare(`SELECT id, access_epoch FROM orgs ORDER BY id`).all(),
	).toEqual([
		{ id: 'org-a', access_epoch: 4 },
		{ id: 'org-b', access_epoch: 7 },
	])
	expect(
		sqlite
			.prepare(
				`SELECT name FROM sqlite_master WHERE name LIKE '\\_\\_%' ESCAPE '\\'`,
			)
			.all(),
	).toEqual([])
	expect(() =>
		insertGrant(sqlite, {
			id: 'grant-by-name',
			resourceType: 'secret',
			resourceId: 'OPENAI_KEY',
			permissions: [],
		}),
	).toThrow(/CHECK constraint failed/)
})

test('0110 fails loudly on a grant whose name maps to no org credential', () => {
	const sqlite = databaseBeforeMigration()
	// Package-scoped secrets were never what a secret grant named.
	insertGrant(sqlite, {
		id: 'grant-orphan',
		resourceType: 'secret',
		resourceId: 'PKG_ONLY',
		deletedAt: '2026-10-02',
		permissions: ['secret:use'],
	})
	expect(() => runMigration(sqlite)).toThrow(/CHECK constraint failed/)
})

test('0110 fails loudly on a grant invite whose name maps to no credential', () => {
	const sqlite = databaseBeforeMigration()
	insertInvite(sqlite, {
		id: 'invite-orphan',
		resourceType: 'integration',
		resourceId: 'gone',
	})
	expect(() => runMigration(sqlite)).toThrow(/CHECK constraint failed/)
})

test('0110 fails loudly when an integration name is both an integration and an MCP server', () => {
	const sqlite = databaseBeforeMigration()
	sqlite.exec(`
		INSERT INTO mcp_server_settings (id, user_id, name, url)
		VALUES ('mcp-github', 'org-a', 'github', 'https://mcp.github.com');
	`)
	insertGrant(sqlite, {
		id: 'grant-ambiguous',
		resourceType: 'integration',
		resourceId: 'github',
		permissions: ['integration:use'],
	})
	expect(() => runMigration(sqlite)).toThrow(/CHECK constraint failed/)
})

test('0110 fails loudly on a secret grant that names a vault door key', () => {
	const sqlite = databaseBeforeMigration()
	insertGrant(sqlite, {
		id: 'grant-door',
		resourceType: 'secret',
		resourceId: 'VAULT_DOOR',
		permissions: ['secret:use'],
	})
	expect(() => runMigration(sqlite)).toThrow(/CHECK constraint failed/)
})

test('0110 fails loudly when a secret grant or invite name is also a package secret', () => {
	for (const insert of [
		(sqlite: DatabaseSync) =>
			insertGrant(sqlite, {
				id: 'grant-also-scoped',
				resourceType: 'secret',
				resourceId: 'OPENAI_KEY',
				permissions: ['secret:use'],
			}),
		(sqlite: DatabaseSync) =>
			insertInvite(sqlite, {
				id: 'invite-also-scoped',
				resourceType: 'secret',
				resourceId: 'OPENAI_KEY',
			}),
	]) {
		const sqlite = databaseBeforeMigration()
		sqlite.exec(`
			INSERT INTO secret_entries (bucket_id, name, encrypted_value)
			VALUES ('bucket-a-pkg', 'OPENAI_KEY', 'ct');
		`)
		insert(sqlite)
		expect(() => runMigration(sqlite)).toThrow(/CHECK constraint failed/)
	}
})

test('the database assigns credential ids on insert, keeps them on upsert, and mints a new one on recreate', () => {
	const sqlite = databaseBeforeMigration()
	runMigration(sqlite)
	const upsert = sqlite.prepare(
		`INSERT INTO secret_entries (bucket_id, name, encrypted_value)
		VALUES ('bucket-a', 'NEW_KEY', ?)
		ON CONFLICT(bucket_id, name) DO UPDATE SET encrypted_value = excluded.encrypted_value`,
	)
	const selectId = `SELECT id FROM secret_entries WHERE name = 'NEW_KEY'`
	upsert.run('ct-1')
	const created = idOf(sqlite, selectId)
	expect(created).toMatch(uuidPattern)
	upsert.run('ct-2')
	expect(idOf(sqlite, selectId)).toBe(created)
	sqlite.exec(`DELETE FROM secret_entries WHERE name = 'NEW_KEY'`)
	upsert.run('ct-3')
	const recreated = idOf(sqlite, selectId)
	expect(recreated).toMatch(uuidPattern)
	expect(recreated).not.toBe(created)

	sqlite.exec(`
		INSERT INTO user_integrations (user_id, name, app_slug) VALUES ('org-a', 'github-2', 'github');
		INSERT INTO secret_provider_bindings (user_id, provider_id, package_id, door_secret_name)
		VALUES ('org-b', 'bitwarden', 'pkg-bw', 'DOOR');
	`)
	expect(
		idOf(sqlite, `SELECT id FROM user_integrations WHERE name = 'github-2'`),
	).toMatch(uuidPattern)
	expect(
		idOf(
			sqlite,
			`SELECT id FROM secret_provider_bindings WHERE provider_id = 'bitwarden'`,
		),
	).toMatch(uuidPattern)
})
