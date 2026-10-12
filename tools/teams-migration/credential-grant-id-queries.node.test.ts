import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	classifyCredentialGrant,
	credentialGrantsByIdSql,
	grantInviteTotalsSql,
	grantTotalsSql,
} from './credential-grant-id-queries.ts'

const now = '2026-10-10T00:00:00.000Z'

function migratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../packages/worker/migrations/', import.meta.url),
	)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at, access_epoch)
			 VALUES ('org-a', 'org-a', 'Org A', ?, ?, 0)`,
		)
		.run(now, now)
	sqlite
		.prepare(
			`INSERT INTO secret_buckets (id, user_id, scope, binding_key, created_at, updated_at)
			 VALUES ('bucket-org', 'org-a', 'user', '', ?, ?)`,
		)
		.run(now, now)
	sqlite
		.prepare(
			`INSERT INTO secret_entries (bucket_id, name, encrypted_value, created_at, updated_at)
			 VALUES ('bucket-org', 'api-key', 'x', ?, ?)`,
		)
		.run(now, now)
	sqlite
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url)
			 VALUES ('mcp-1', 'org-a', 'linear', 'https://mcp.example.com')`,
		)
		.run()
	const secretId = (
		sqlite
			.prepare(`SELECT id FROM secret_entries WHERE name = 'api-key'`)
			.get() as { id: string }
	).id
	const grant = sqlite.prepare(
		`INSERT INTO grants (
			id, org_id, resource_type, resource_id, subject_type, subject_id,
			preset, created_by_user_id, created_at, updated_at, deleted_at
		) VALUES (?, 'org-a', ?, ?, 'user', 'member-id', 'use', 'owner-id', ?, ?, ?)`,
	)
	grant.run('g-secret', 'credential', secretId, now, now, null)
	grant.run('g-mcp', 'credential', 'mcp-1', now, now, null)
	grant.run('g-gone', 'credential', 'deleted-credential', now, now, now)
	grant.run('g-package', 'package', 'pkg-1', now, now, null)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES ('g-secret', 'secret:use'), ('g-mcp', 'integration:use'),
			        ('g-mcp', 'integration:read'), ('g-gone', 'secret:use'),
			        ('g-package', 'package:read')`,
		)
		.run()
	sqlite
		.prepare(
			`INSERT INTO invites (
				id, org_id, kind, resource_type, resource_id, preset, invitee_username,
				token_hash, status, invited_by_user_id, expires_at, created_at
			) VALUES ('i-mcp', 'org-a', 'grant', 'credential', 'mcp-1', 'use', 'jane',
				'hash-1', 'pending', 'owner-id', ?, ?)`,
		)
		.run(now, now)
	return sqlite
}

test('every credential grant is checked against the credential rows its id names', () => {
	const sqlite = migratedDb()
	const rows = sqlite.prepare(credentialGrantsByIdSql).all() as Array<
		Record<string, number | string>
	>
	expect(
		Object.fromEntries(
			rows.map((row) => [
				row.grant_id,
				[row.grant_state, classifyCredentialGrant(row as never)],
			]),
		),
	).toEqual({
		'g-secret': ['live', 'resolved'],
		'g-mcp': ['live', 'resolved'],
		'g-gone': ['deleted', 'orphan'],
	})
	expect(rows.find((row) => row.grant_id === 'g-mcp')).toMatchObject({
		permissions: 2,
		mcp_server_matches: 1,
		secret_matches: 0,
	})

	expect(sqlite.prepare(grantTotalsSql).all()).toEqual([
		{
			resource_type: 'credential',
			grant_state: 'deleted',
			grants: 1,
			permissions: 1,
		},
		{
			resource_type: 'credential',
			grant_state: 'live',
			grants: 2,
			permissions: 3,
		},
		{
			resource_type: 'package',
			grant_state: 'live',
			grants: 1,
			permissions: 1,
		},
	])
	expect(sqlite.prepare(grantInviteTotalsSql).all()).toEqual([
		{ resource_type: 'credential', status: 'pending', invites: 1 },
	])
})

test('an id that matches more than one credential row is ambiguous', () => {
	expect(
		classifyCredentialGrant({
			secret_matches: 1,
			vault_matches: 0,
			integration_matches: 0,
			mcp_server_matches: 1,
		}),
	).toBe('ambiguous')
})
