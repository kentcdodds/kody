import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0140-backfill-integration-connected-at.sql'

function applyMigrationsBefore(db: DatabaseSync, fileName: string) {
	for (const name of readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql') && name < fileName)
		.sort()) {
		db.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
}

test('backfill stamps connected_at for live token rows and leaves config-only and already-connected alone', () => {
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
			user_id, name, app_slug, access_token_encrypted, connected_at,
			token_refreshed_at, created_at, updated_at, deleted_at
		) VALUES
			('user-1', 'token-null', 'github', 'ct-access', NULL,
				'2026-09-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
				'2026-08-15T00:00:00.000Z', NULL),
			('user-1', 'token-blank', 'github', '  ', NULL,
				NULL, '2026-08-01T00:00:00.000Z', '2026-08-15T00:00:00.000Z', NULL),
			('user-1', 'config-only', 'github', NULL, NULL,
				NULL, '2026-08-01T00:00:00.000Z', '2026-08-15T00:00:00.000Z', NULL),
			('user-1', 'already', 'google', 'ct-access', '2026-07-01T00:00:00.000Z',
				NULL, '2026-08-01T00:00:00.000Z', '2026-08-15T00:00:00.000Z', NULL),
			('user-1', 'soft-deleted', 'google', 'ct-access', NULL,
				NULL, '2026-08-01T00:00:00.000Z', '2026-08-15T00:00:00.000Z',
				'2026-09-01T00:00:00.000Z'),
			('user-1', 'no-refresh', 'google', 'ct-access', NULL,
				NULL, '2026-08-01T00:00:00.000Z', '2026-08-15T00:00:00.000Z', NULL);
	`)

	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)

	const rows = sqlite
		.prepare(`SELECT name, connected_at FROM user_integrations ORDER BY name`)
		.all() as Array<{ name: string; connected_at: string | null }>
	expect(rows).toEqual([
		{ name: 'already', connected_at: '2026-07-01T00:00:00.000Z' },
		{ name: 'config-only', connected_at: null },
		{ name: 'no-refresh', connected_at: '2026-08-15T00:00:00.000Z' },
		{ name: 'soft-deleted', connected_at: null },
		{ name: 'token-blank', connected_at: null },
		{ name: 'token-null', connected_at: '2026-09-01T00:00:00.000Z' },
	])
})
