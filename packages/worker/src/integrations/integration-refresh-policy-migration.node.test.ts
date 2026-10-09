import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0073-integration-refresh-policy.sql'

function applyMigrationsBefore(db: DatabaseSync, fileName: string) {
	for (const name of readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql') && name < fileName)
		.sort()) {
		db.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
}

test('refresh policy backfill infers from stored tokens and clears only stale missing_refresh_token snapshots', () => {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrationsBefore(sqlite, migrationFileName)
	sqlite.exec(`
		INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
		VALUES
			('user-1', 'github', 'github', 'gh-client',
				'https://github.com/login/oauth/access_token', 'confidential'),
			('user-1', 'google', 'google', 'google-client',
				'https://oauth2.googleapis.com/token', 'confidential');
		INSERT INTO user_integrations (
			user_id, name, app_slug, access_token_encrypted, refresh_token_encrypted,
			token_refreshed_at, auth_failed_at, auth_failed_reason,
			auth_failed_http_status, auth_failed_reconnectable
		) VALUES
			('user-1', 'github-kent', 'github', 'ct-access', NULL, NULL,
				'2026-09-30T00:00:00.000Z', 'missing_refresh_token', NULL, 1),
			('user-1', 'github-bot', 'github', 'ct-access', '', NULL,
				'2026-09-30T00:00:00.000Z', 'provider_rejected', 401, 1),
			('user-1', 'google', 'google', 'ct-access', 'ct-refresh', NULL,
				NULL, NULL, NULL, NULL),
			('user-1', 'google-lost', 'google', 'ct-access', NULL,
				'2026-09-01T00:00:00.000Z',
				'2026-09-30T00:00:00.000Z', 'missing_refresh_token', NULL, 1),
			('user-1', 'config-only', 'github', NULL, NULL, NULL,
				'2026-09-30T00:00:00.000Z', 'missing_refresh_token', NULL, 1);
	`)

	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)

	const rows = sqlite
		.prepare(
			`SELECT name, refresh_policy, auth_failed_at, auth_failed_reason,
				auth_failed_http_status, auth_failed_reconnectable
			FROM user_integrations
			ORDER BY name`,
		)
		.all()
	expect(rows).toEqual([
		{
			name: 'config-only',
			refresh_policy: null,
			auth_failed_at: '2026-09-30T00:00:00.000Z',
			auth_failed_reason: 'missing_refresh_token',
			auth_failed_http_status: null,
			auth_failed_reconnectable: 1,
		},
		{
			name: 'github-bot',
			refresh_policy: 'not_applicable',
			auth_failed_at: '2026-09-30T00:00:00.000Z',
			auth_failed_reason: 'provider_rejected',
			auth_failed_http_status: 401,
			auth_failed_reconnectable: 1,
		},
		{
			name: 'github-kent',
			refresh_policy: 'not_applicable',
			auth_failed_at: null,
			auth_failed_reason: null,
			auth_failed_http_status: null,
			auth_failed_reconnectable: null,
		},
		{
			name: 'google',
			refresh_policy: 'required',
			auth_failed_at: null,
			auth_failed_reason: null,
			auth_failed_http_status: null,
			auth_failed_reconnectable: null,
		},
		{
			name: 'google-lost',
			refresh_policy: 'required',
			auth_failed_at: '2026-09-30T00:00:00.000Z',
			auth_failed_reason: 'missing_refresh_token',
			auth_failed_http_status: null,
			auth_failed_reconnectable: 1,
		},
	])
})
