import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	classifyCredentialGrant,
	classifyNameKeyedCredential,
	credentialGrantsByIdSql,
	grantInviteTotalsSql,
	grantTotalsSql,
	nameKeyedCredentialGrantsSql,
	nameKeyedCredentialInvitesSql,
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
			 VALUES ('bucket-org', 'org-a', 'user', '', ?, ?),
			        ('bucket-pkg', 'org-a', 'package', 'pkg-1', ?, ?)`,
		)
		.run(now, now, now, now)
	sqlite
		.prepare(
			`INSERT INTO secret_entries (bucket_id, name, encrypted_value, created_at, updated_at)
			 VALUES ('bucket-org', 'api-key', 'x', ?, ?),
			        ('bucket-org', 'org-only', 'x', ?, ?),
			        ('bucket-org', 'door-key', 'x', ?, ?),
			        ('bucket-pkg', 'api-key', 'x', ?, ?)`,
		)
		.run(now, now, now, now, now, now, now, now)
	sqlite
		.prepare(
			`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id, created_at, updated_at)
			 VALUES ('pkg-1', 'org-a', '@org-a/vault', 'vault', '', 'src-1', ?, ?)`,
		)
		.run(now, now)
	sqlite
		.prepare(
			`INSERT INTO secret_provider_bindings (user_id, provider_id, package_id, door_secret_name)
			 VALUES ('org-a', '1password', 'pkg-1', 'door-key')`,
		)
		.run()
	sqlite
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url)
			 VALUES ('mcp-1', 'org-a', 'linear', 'https://mcp.example.com'),
			        ('mcp-2', 'org-a', 'dual', 'https://dual.example.com')`,
		)
		.run()
	const grant = sqlite.prepare(
		`INSERT INTO grants (
			id, org_id, resource_type, resource_id, subject_type, subject_id,
			preset, created_by_user_id, created_at, updated_at, deleted_at
		) VALUES (?, 'org-a', ?, ?, 'user', 'member-id', 'use', 'owner-id', ?, ?, ?)`,
	)
	grant.run('g-secret', 'secret', 'api-key', now, now, null)
	grant.run('g-org-only', 'secret', 'org-only', now, now, null)
	grant.run('g-door', 'secret', 'door-key', now, now, null)
	grant.run('g-gone', 'secret', 'deleted-secret', now, now, now)
	grant.run('g-mcp', 'integration', 'linear', now, now, null)
	grant.run('g-package', 'package', 'pkg-1', now, now, null)
	sqlite
		.prepare(
			`INSERT INTO grant_permissions (grant_id, permission)
			 VALUES ('g-secret', 'secret:use'), ('g-org-only', 'secret:use'),
			        ('g-door', 'secret:use'),
			        ('g-gone', 'secret:use'), ('g-mcp', 'integration:use'),
			        ('g-mcp', 'integration:read'), ('g-package', 'package:read')`,
		)
		.run()
	sqlite
		.prepare(
			`INSERT INTO invites (
				id, org_id, kind, resource_type, resource_id, preset, invitee_username,
				token_hash, status, invited_by_user_id, expires_at, created_at
			) VALUES ('i-mcp', 'org-a', 'grant', 'integration', 'linear', 'use', 'jane',
				'hash-1', 'pending', 'owner-id', ?, ?)`,
		)
		.run(now, now)
	return sqlite
}

test('dry-runs the name-to-id mapping for every name-keyed grant and invite', () => {
	const sqlite = migratedDb()
	const grants = sqlite.prepare(nameKeyedCredentialGrantsSql).all() as Array<
		Record<string, number | string> & { resource_type: string }
	>
	const outcomes = Object.fromEntries(
		grants.map((row) => [
			row.grant_id,
			classifyNameKeyedCredential(row.resource_type, row as never),
		]),
	)
	expect(outcomes).toEqual({
		'g-secret': 'also-scoped',
		'g-org-only': 'mapped',
		'g-door': 'shared-with-vault',
		'g-gone': 'orphan',
		'g-mcp': 'mapped',
	})
	expect(grants.find((row) => row.grant_id === 'g-secret')).toMatchObject({
		grant_state: 'live',
		org_state: 'live',
		permissions: 1,
		org_secret_matches: 1,
		scoped_secret_matches: 1,
	})
	expect(grants.find((row) => row.grant_id === 'g-gone')).toMatchObject({
		grant_state: 'deleted',
	})

	const invites = sqlite.prepare(nameKeyedCredentialInvitesSql).all() as Array<
		Record<string, number | string> & { resource_type: string }
	>
	expect(invites).toEqual([
		expect.objectContaining({
			invite_id: 'i-mcp',
			status: 'pending',
			mcp_server_matches: 1,
		}),
	])

	expect(sqlite.prepare(grantTotalsSql).all()).toEqual([
		{
			resource_type: 'integration',
			grant_state: 'live',
			grants: 1,
			permissions: 2,
		},
		{
			resource_type: 'package',
			grant_state: 'live',
			grants: 1,
			permissions: 1,
		},
		{
			resource_type: 'secret',
			grant_state: 'deleted',
			grants: 1,
			permissions: 1,
		},
		{ resource_type: 'secret', grant_state: 'live', grants: 3, permissions: 3 },
	])
	expect(sqlite.prepare(grantInviteTotalsSql).all()).toEqual([
		{ resource_type: 'integration', status: 'pending', invites: 1 },
	])
})

test('an integration name shared by an integration and an MCP server is ambiguous', () => {
	expect(
		classifyNameKeyedCredential('integration', {
			org_secret_matches: 0,
			scoped_secret_matches: 0,
			vault_door_matches: 0,
			integration_matches: 1,
			mcp_server_matches: 1,
		}),
	).toBe('ambiguous')
})

test('the id-keyed check reports not-migrated until the id columns exist', () => {
	const sqlite = migratedDb()
	expect(() => sqlite.prepare(credentialGrantsByIdSql).all()).toThrow(
		/no such column/,
	)
	expect(
		classifyCredentialGrant({
			secret_matches: 1,
			vault_matches: 0,
			integration_matches: 0,
			mcp_server_matches: 0,
		}),
	).toBe('resolved')
	expect(
		classifyCredentialGrant({
			secret_matches: 0,
			vault_matches: 0,
			integration_matches: 0,
			mcp_server_matches: 0,
		}),
	).toBe('orphan')
})
