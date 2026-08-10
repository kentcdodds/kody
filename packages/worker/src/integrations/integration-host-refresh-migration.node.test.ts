import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0008-refresh-google-platform-hosts.sql'

function applyMigrationsBeforeHostRefresh(db: DatabaseSync) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter(
			(fileName) => fileName.endsWith('.sql') && fileName < migrationFileName,
		)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

test('Google platform host backfill is additive, lane-specific, and idempotent', () => {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrationsBeforeHostRefresh(sqlite)
	sqlite.exec(`
		INSERT INTO platform_oauth_apps (
			slug, provider, client_id, token_url, authorize_url, flow,
			required_hosts_json
		) VALUES (
			'google-platform', 'google', 'google-client',
			'https://oauth2.googleapis.com/token',
			'https://accounts.google.com/o/oauth2/v2/auth', 'confidential',
			'["openidconnect.googleapis.com","www.googleapis.com"]'
		);
		INSERT INTO user_oauth_apps (
			user_id, slug, provider, client_id, token_url, flow
		) VALUES (
			'user-custom', 'google', 'google', 'custom-client',
			'https://oauth2.googleapis.com/token', 'pkce'
		);
		INSERT INTO user_integrations (
			user_id, name, app_slug, platform_app_slug, required_hosts_json,
			access_token_secret_name
		) VALUES
			(
				'user-platform', 'google', NULL, 'google-platform',
				'["user-added.example.com","www.googleapis.com"]', 'googleAccessToken'
			),
			(
				'user-custom', 'google', 'google', NULL,
				'["custom-only.example.com"]', 'customGoogleAccessToken'
			);
	`)
	const migration = readFileSync(
		new URL(migrationFileName, migrationsDirectory),
		'utf8',
	)

	sqlite.exec(migration)
	sqlite.exec(migration)

	const rows = sqlite
		.prepare(
			`SELECT user_id, required_hosts_json
			FROM user_integrations
			ORDER BY user_id`,
		)
		.all() as Array<{ user_id: string; required_hosts_json: string }>
	expect(
		rows.map((row) => ({
			userId: row.user_id,
			requiredHosts: JSON.parse(row.required_hosts_json),
		})),
	).toEqual([
		{
			userId: 'user-custom',
			requiredHosts: ['custom-only.example.com'],
		},
		{
			userId: 'user-platform',
			requiredHosts: [
				'openidconnect.googleapis.com',
				'user-added.example.com',
				'www.googleapis.com',
			],
		},
	])
})
