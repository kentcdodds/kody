import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

test('Teams expand migration 0086 defines org primitives', () => {
	const migrationsDirectory = new URL('../../migrations/', import.meta.url)
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL('0086-teams-orgs-tables.sql', migrationsDirectory),
			'utf8',
		),
	)
	const orgs = sqlite
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orgs'`,
		)
		.get()
	expect(orgs).toBeTruthy()
	const handles = sqlite
		.prepare(
			`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'handles'`,
		)
		.get()
	expect(handles).toBeTruthy()
})

test('Teams P4 migration 0090 binds credentials and rewrites legacy scopes', () => {
	const migrationsDirectory = new URL('../../migrations/', import.meta.url)
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE api_tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			scopes_json TEXT NOT NULL
		);
		CREATE TABLE cli_credential_bootstrap_codes (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			scopes_json TEXT NOT NULL
		);
		CREATE TABLE mcp_agent_sessions (
			do_id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL
		);
		CREATE TABLE connection_profiles (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL
		);
	`)
	sqlite
		.prepare(
			`INSERT INTO api_tokens (id, user_id, scopes_json) VALUES (?, ?, ?)`,
		)
		.run('tok-1', 'user-1', JSON.stringify(['account:write', 'local-execute']))
	sqlite
		.prepare(
			`INSERT INTO cli_credential_bootstrap_codes (id, user_id, scopes_json)
			 VALUES (?, ?, ?)`,
		)
		.run('bc-1', 'user-1', JSON.stringify(['account:read', 'local-execute']))
	sqlite
		.prepare(`INSERT INTO mcp_agent_sessions (do_id, user_id) VALUES (?, ?)`)
		.run('do-1', 'user-1')
	sqlite
		.prepare(
			`INSERT INTO connection_profiles (id, user_id, name) VALUES (?, ?, ?)`,
		)
		.run('p-1', 'user-1', 'work')

	sqlite.exec(
		readFileSync(
			new URL('0090-teams-credential-org-binding.sql', migrationsDirectory),
			'utf8',
		),
	)

	const token = sqlite
		.prepare(`SELECT org_id, scopes_json FROM api_tokens WHERE id = ?`)
		.get('tok-1') as { org_id: string; scopes_json: string }
	expect(token.org_id).toBe('user-1')
	expect(JSON.parse(token.scopes_json)).toEqual([
		'billing:read',
		'billing:write',
		'member:read',
		'org:execute',
		'org:read',
		'org:write',
	])

	const bootstrap = sqlite
		.prepare(
			`SELECT org_id, scopes_json FROM cli_credential_bootstrap_codes WHERE id = ?`,
		)
		.get('bc-1') as { org_id: string; scopes_json: string }
	expect(bootstrap.org_id).toBe('user-1')
	expect(JSON.parse(bootstrap.scopes_json)).toEqual([
		'billing:read',
		'member:read',
		'org:execute',
		'org:read',
	])

	expect(
		sqlite
			.prepare(`SELECT org_id FROM mcp_agent_sessions WHERE do_id = ?`)
			.get('do-1'),
	).toEqual({ org_id: 'user-1' })
	expect(
		sqlite
			.prepare(`SELECT org_id FROM connection_profiles WHERE id = ?`)
			.get('p-1'),
	).toEqual({ org_id: 'user-1' })
})
