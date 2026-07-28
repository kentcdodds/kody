import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const hygieneMigration = '0103-integration-data-hygiene.sql'

function applyMigrationsBefore(db: DatabaseSync, exclusiveUpperBound: string) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql') && file < exclusiveUpperBound)
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}

function applyMigration(db: DatabaseSync, fileName: string) {
	db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
}

const now = '2026-02-01T00:00:00.000Z'

function seedOauthAppAndConnection(
	db: DatabaseSync,
	input: {
		userId: string
		name: string
		requiredHostsJson: string
		refreshTokenSecretName: string | null
	},
) {
	db.prepare(
		`INSERT INTO user_oauth_apps (
			user_id, slug, provider, label, client_id, client_secret_secret_name,
			token_url, authorize_url, api_base_url, flow, use_pkce,
			token_exchange_style, scope_separator, extra_authorize_params_json,
			created_at, updated_at
		) VALUES (?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, 'pkce', NULL, NULL, NULL, '{}', ?, ?)`,
	).run(
		input.userId,
		input.name,
		input.name,
		`${input.name}-client-id`,
		`https://example.com/${input.name}/token`,
		now,
		now,
	)
	db.prepare(
		`INSERT INTO user_integrations (
			user_id, name, app_slug, account_label, description, scopes_json,
			required_hosts_json, access_token_secret_name, refresh_token_secret_name,
			connected_at, token_refreshed_at, created_at, updated_at
		) VALUES (?, ?, ?, NULL, '', '[]', ?, ?, ?, NULL, NULL, ?, ?)`,
	).run(
		input.userId,
		input.name,
		input.name,
		input.requiredHostsJson,
		`${input.name}AccessToken`,
		input.refreshTokenSecretName,
		now,
		now,
	)
}

function insertUserValueBucket(
	db: DatabaseSync,
	input: { bucketId: string; userId: string },
) {
	db.prepare(
		`INSERT INTO value_buckets (
			id, user_id, scope, binding_key, expires_at, created_at, updated_at
		) VALUES (?, ?, 'user', '', NULL, ?, ?)`,
	).run(input.bucketId, input.userId, now, now)
}

function insertValue(
	db: DatabaseSync,
	input: { bucketId: string; name: string; value: string },
) {
	db.prepare(
		`INSERT INTO value_entries (
			bucket_id, name, description, value, created_at, updated_at
		) VALUES (?, ?, '', ?, ?, ?)`,
	).run(input.bucketId, input.name, input.value, now, now)
}

function insertUserSecret(
	db: DatabaseSync,
	input: { bucketId: string; userId: string; name: string },
) {
	db.prepare(
		`INSERT OR IGNORE INTO secret_buckets (
			id, user_id, scope, binding_key, expires_at, created_at, updated_at
		) VALUES (?, ?, 'user', '', NULL, ?, ?)`,
	).run(input.bucketId, input.userId, now, now)
	db.prepare(
		`INSERT INTO secret_entries (
			bucket_id, name, description, encrypted_value, created_at, updated_at
		) VALUES (?, ?, '', 'encrypted', ?, ?)`,
	).run(input.bucketId, input.name, now, now)
}

test('0103 cleans leftover integration values, orphan tokens, and URL hosts; restart-safe', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, hygieneMigration)

	insertUserValueBucket(db, { bucketId: 'bucket-a', userId: 'user-a' })
	insertValue(db, {
		bucketId: 'bucket-a',
		name: '_integration:abandoned',
		value: '{"tokenUrl":"https://example.com/token"}',
	})
	insertValue(db, {
		bucketId: 'bucket-a',
		name: 'keep-me',
		value: 'ordinary',
	})

	seedOauthAppAndConnection(db, {
		userId: 'user-orphan',
		name: 'linkedin',
		requiredHostsJson: JSON.stringify([
			'https://api.linkedin.com',
			'www.linkedin.com',
			'HTTPS://API.LINKEDIN.COM/v2',
		]),
		refreshTokenSecretName: 'linkedinRefreshToken',
	})
	seedOauthAppAndConnection(db, {
		userId: 'user-valid',
		name: 'github',
		requiredHostsJson: JSON.stringify(['api.github.com', 'github.com']),
		refreshTokenSecretName: 'githubRefreshToken',
	})
	insertUserSecret(db, {
		bucketId: 'secret-bucket-valid',
		userId: 'user-valid',
		name: 'githubRefreshToken',
	})

	applyMigration(db, hygieneMigration)
	// Restart-safe: a second apply must not throw or undo the cleanup.
	applyMigration(db, hygieneMigration)

	const valueNames = (
		db
			.prepare(
				`SELECT e.name
				FROM value_entries e
				INNER JOIN value_buckets b ON b.id = e.bucket_id
				WHERE b.user_id = ?
				ORDER BY e.name ASC`,
			)
			.all('user-a') as Array<{ name: string }>
	).map((row) => row.name)
	expect(valueNames).toEqual(['keep-me'])
	expect(
		(
			db
				.prepare(
					`SELECT count(*) AS count FROM value_entries
					WHERE name LIKE '\\_integration:%' ESCAPE '\\'`,
				)
				.get() as { count: number }
		).count,
	).toBe(0)

	const orphan = db
		.prepare(
			`SELECT refresh_token_secret_name, required_hosts_json
			FROM user_integrations WHERE user_id = ? AND name = ?`,
		)
		.get('user-orphan', 'linkedin') as {
		refresh_token_secret_name: string | null
		required_hosts_json: string
	}
	const valid = db
		.prepare(
			`SELECT refresh_token_secret_name, required_hosts_json
			FROM user_integrations WHERE user_id = ? AND name = ?`,
		)
		.get('user-valid', 'github') as {
		refresh_token_secret_name: string | null
		required_hosts_json: string
	}
	expect(orphan.refresh_token_secret_name).toBeNull()
	expect(JSON.parse(orphan.required_hosts_json)).toEqual([
		'api.linkedin.com',
		'www.linkedin.com',
	])
	expect(valid.refresh_token_secret_name).toBe('githubRefreshToken')
	expect(JSON.parse(valid.required_hosts_json)).toEqual([
		'api.github.com',
		'github.com',
	])
})
