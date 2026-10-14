import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const migrationFileName = '0141-fix-compound-provider-marks.sql'

function applyMigrationsBefore(db: DatabaseSync, fileName: string) {
	for (const name of readdirSync(migrationsDirectory)
		.filter((name) => name.endsWith('.sql') && name < fileName)
		.sort()) {
		db.exec(readFileSync(new URL(name, migrationsDirectory), 'utf8'))
	}
}

test('compound provider mark backfill restores kody-exchange and cal-com without touching google families', () => {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrationsBefore(sqlite, migrationFileName)
	sqlite.exec(`
		INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, flow)
		VALUES
			('user-1', 'kody-exchange', 'kody', 'kx-client',
				'https://kody.exchange/oauth/token', 'pkce'),
			('user-1', 'cal-com', 'cal', 'cal-client',
				'https://api.cal.com/oauth/token', 'confidential'),
			('user-1', 'google-calendar', 'google', 'google-client',
				'https://oauth2.googleapis.com/token', 'confidential'),
			('user-1', 'github-kent', 'github', 'gh-client',
				'https://github.com/login/oauth/access_token', 'confidential');
		INSERT INTO user_integrations (
			user_id, name, app_slug, provider, access_token_encrypted, connected_at
		) VALUES
			('user-1', 'kody-exchange', 'kody-exchange', 'kody', 'ct', '2026-01-01T00:00:00.000Z'),
			('user-1', 'cal-com', 'cal-com', 'cal', 'ct', '2026-01-01T00:00:00.000Z'),
			('user-1', 'google-calendar', 'google-calendar', 'google', 'ct',
				'2026-01-01T00:00:00.000Z'),
			('user-1', 'github-kent', 'github-kent', 'github', 'ct',
				'2026-01-01T00:00:00.000Z');
	`)

	sqlite.exec(
		readFileSync(new URL(migrationFileName, migrationsDirectory), 'utf8'),
	)

	expect(
		sqlite
			.prepare(`SELECT slug, provider FROM user_oauth_apps ORDER BY slug`)
			.all(),
	).toEqual([
		{ slug: 'cal-com', provider: 'cal-com' },
		{ slug: 'github-kent', provider: 'github' },
		{ slug: 'google-calendar', provider: 'google' },
		{ slug: 'kody-exchange', provider: 'kody-exchange' },
	])
	expect(
		sqlite
			.prepare(`SELECT name, provider FROM user_integrations ORDER BY name`)
			.all(),
	).toEqual([
		{ name: 'cal-com', provider: 'cal-com' },
		{ name: 'github-kent', provider: 'github' },
		{ name: 'google-calendar', provider: 'google' },
		{ name: 'kody-exchange', provider: 'kody-exchange' },
	])
})
