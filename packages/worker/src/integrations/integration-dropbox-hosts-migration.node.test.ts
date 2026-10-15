import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0143-add-dropbox-content-hosts.sql'

const dropboxHosts = [
	'api.dropboxapi.com',
	'content.dropboxapi.com',
	'notify.dropboxapi.com',
]

function applyMigrationsBefore(db: DatabaseSync, fileName: string) {
	for (const name of readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql') && name < fileName)
		.sort()) {
		db.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
}

function seed(db: DatabaseSync) {
	db.exec(`
		INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, authorize_url, flow)
		VALUES
			('org-1', 'dropbox', 'dropbox', 'dbx-client',
				'https://api.dropboxapi.com/oauth2/token',
				'https://www.dropbox.com/oauth2/authorize', 'pkce'),
			('org-1', 'dropbox-legacy', 'dropbox', 'dbx-legacy-client',
				'https://API.dropbox.com/oauth2/token',
				'https://www.dropbox.com/oauth2/authorize', 'pkce'),
			('org-1', 'dropbox-proxy', 'dropbox', 'proxy-client',
				'https://auth.example.com/oauth2/token', NULL, 'pkce'),
			('org-1', 'dropbox-lookalike', 'dropbox', 'lookalike-client',
				'https://api.dropboxapi.com.example.com/oauth2/token', NULL, 'pkce'),
			('org-1', 'github', 'github', 'gh-client',
				'https://github.com/login/oauth/access_token', NULL, 'confidential'),
			('org-2', 'dropbox', 'dropbox', 'dbx-client-2',
				'https://api.dropboxapi.com/oauth2/token', NULL, 'pkce');
		INSERT INTO user_integrations (
			user_id, name, app_slug, required_hosts_json, access_token_encrypted,
			updated_at, deleted_at
		) VALUES
			('org-1', 'dropbox', 'dropbox', '["api.dropboxapi.com"]',
				'ct-dropbox', '2026-10-01T00:00:00.000Z', NULL),
			('org-1', 'dropbox-work', 'dropbox',
				'["api.dropboxapi.com","files.example.com"]',
				'ct-work', '2026-10-01T00:00:00.000Z', NULL),
			('org-1', 'dropbox-legacy', 'dropbox-legacy', '[]',
				'ct-legacy', '2026-10-01T00:00:00.000Z', NULL),
			('org-1', 'dropbox-proxy', 'dropbox-proxy', '["auth.example.com"]',
				'ct-proxy', '2026-10-01T00:00:00.000Z', NULL),
			('org-1', 'dropbox-lookalike', 'dropbox-lookalike',
				'["api.dropboxapi.com.example.com"]',
				'ct-lookalike', '2026-10-01T00:00:00.000Z', NULL),
			('org-1', 'github', 'github', '["api.github.com"]',
				'ct-github', '2026-10-01T00:00:00.000Z', NULL),
			('org-1', 'dropbox-deleted', 'dropbox', '["api.dropboxapi.com"]',
				'ct-deleted', '2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z'),
			('org-2', 'dropbox', 'dropbox',
				'["api.dropboxapi.com","content.dropboxapi.com","notify.dropboxapi.com"]',
				'ct-complete', '2026-10-01T00:00:00.000Z', NULL);
	`)
}

function readRows(db: DatabaseSync) {
	return (
		db
			.prepare(
				`SELECT user_id, name, required_hosts_json, access_token_encrypted, updated_at
				FROM user_integrations ORDER BY user_id, name`,
			)
			.all() as Array<{
			user_id: string
			name: string
			required_hosts_json: string
			access_token_encrypted: string
			updated_at: string
		}>
	).map((row) => ({
		owner: row.user_id,
		name: row.name,
		hosts: JSON.parse(row.required_hosts_json) as Array<string>,
		token: row.access_token_encrypted,
		updatedAt: row.updated_at,
	}))
}

test('Dropbox host backfill adds only the official hosts, only to Dropbox-token connections, and is idempotent', () => {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrationsBefore(sqlite, migrationFileName)
	seed(sqlite)
	const before = readRows(sqlite)
	const migration = readFileSync(
		new URL(migrationFileName, migrationsDirectory),
		'utf8',
	)

	sqlite.exec(migration)
	const once = readRows(sqlite)
	sqlite.exec(migration)
	expect(readRows(sqlite)).toEqual(once)

	const hostsByName = new Map(
		once.map((row) => [`${row.owner}/${row.name}`, row.hosts]),
	)
	expect(hostsByName.get('org-1/dropbox')).toEqual(dropboxHosts)
	expect(hostsByName.get('org-1/dropbox-work')).toEqual([
		'api.dropboxapi.com',
		'content.dropboxapi.com',
		'files.example.com',
		'notify.dropboxapi.com',
	])
	expect(hostsByName.get('org-1/dropbox-legacy')).toEqual(dropboxHosts)
	// A token from another endpoint must never be sent to Dropbox.
	expect(hostsByName.get('org-1/dropbox-proxy')).toEqual(['auth.example.com'])
	expect(hostsByName.get('org-1/dropbox-lookalike')).toEqual([
		'api.dropboxapi.com.example.com',
	])
	expect(hostsByName.get('org-1/github')).toEqual(['api.github.com'])
	expect(hostsByName.get('org-1/dropbox-deleted')).toEqual([
		'api.dropboxapi.com',
	])
	expect(hostsByName.get('org-2/dropbox')).toEqual(dropboxHosts)

	// Tokens and every other column stay as they were.
	expect(once.map(({ hosts: _hosts, ...rest }) => rest)).toEqual(
		before.map(({ hosts: _hosts, ...rest }) => rest),
	)
})

test('Dropbox host backfill covers a platform-lane Dropbox app', () => {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrationsBefore(sqlite, migrationFileName)
	sqlite.exec(`
		INSERT INTO platform_oauth_apps (
			slug, provider, client_id, token_url, authorize_url, flow
		) VALUES (
			'dropbox-platform', 'dropbox', 'dbx-platform',
			'https://api.dropboxapi.com/oauth2/token',
			'https://www.dropbox.com/oauth2/authorize', 'confidential'
		);
		INSERT INTO user_integrations (
			user_id, name, platform_app_slug, required_hosts_json
		) VALUES ('org-1', 'dropbox', 'dropbox-platform', '["api.dropboxapi.com"]');
	`)

	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)

	const row = sqlite
		.prepare(`SELECT required_hosts_json FROM user_integrations`)
		.get() as { required_hosts_json: string }
	expect(JSON.parse(row.required_hosts_json)).toEqual(dropboxHosts)
})
