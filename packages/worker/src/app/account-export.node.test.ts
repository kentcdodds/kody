import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	createAccountExport,
	getAccountExportD1UserColumnCoverage,
	readAccountExportSection,
} from './account-export.ts'

function quoteSqlIdentifier(identifier: string) {
	return `"${identifier.replaceAll('"', '""')}"`
}

function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../migrations/', import.meta.url)
	for (const fileName of readdirSync(migrationsDir)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDir), 'utf8'))
	}
}

function createD1FromSqlite(db: DatabaseSync) {
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							const statement = db.prepare(query)
							const rows = statement.all(...params) as Array<T>
							return { results: rows, meta: { changes: 0 } }
						},
						async first<T>() {
							const statement = db.prepare(query)
							return (statement.get(...params) ?? null) as T | null
						},
						async run() {
							const statement = db.prepare(query)
							const result = statement.run(...params)
							return { meta: { changes: result.changes } }
						},
					}
				},
				async all<T>() {
					const statement = db.prepare(query)
					const rows = statement.all() as Array<T>
					return { results: rows, meta: { changes: 0 } }
				},
				async first<T>() {
					const statement = db.prepare(query)
					return (statement.get() ?? null) as T | null
				},
				async run() {
					const statement = db.prepare(query)
					const result = statement.run()
					return { meta: { changes: result.changes } }
				},
			}
		},
		async exec(query: string) {
			db.exec(query)
		},
	} as unknown as D1Database
}

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	return {
		sqlite,
		db: createD1FromSqlite(sqlite),
	}
}

test('account export D1 coverage includes every live user-owned schema column', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrations(db)
	const tables = db
		.prepare(
			`SELECT name
			FROM sqlite_schema
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
			ORDER BY name`,
		)
		.all() as Array<{ name: string }>
	const liveUserColumns = new Set<string>()
	for (const table of tables) {
		const columns = db
			.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table.name)})`)
			.all() as Array<{ name: string }>
		for (const column of columns) {
			if (column.name === 'user_id' || column.name.endsWith('_user_id')) {
				liveUserColumns.add(`${table.name}.${column.name}`)
			}
		}
	}
	const coveredColumns = getAccountExportD1UserColumnCoverage()
	const missing = [...liveUserColumns].filter(
		(column) => !coveredColumns.has(column),
	)
	const stale = [...coveredColumns].filter(
		(column) => !liveUserColumns.has(column),
	)
	expect(missing, 'user-owned D1 columns missing from account export').toEqual(
		[],
	)
	expect(stale, 'account export references stale D1 columns').toEqual([])
})

test('createAccountExport redacts secrets and credential-equivalent hashes', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (id, username, email, password_hash, created_at, updated_at, email_verified_at)
		VALUES
			(1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05', '2026-07-05', '2026-07-05'),
			(2, 'user-b', 'b@example.com', 'password-hash-b', '2026-07-05', '2026-07-05', '2026-07-05');

		INSERT INTO secret_buckets (id, user_id, scope, binding_key, created_at, updated_at)
		VALUES ('secret-bucket-a', 'user-aaa', 'user', 'global', '2026-07-05', '2026-07-05');
		INSERT INTO secret_entries (
			bucket_id,
			name,
			description,
			encrypted_value,
			allowed_hosts,
			allowed_capabilities,
			allowed_packages,
			lookup_hash,
			created_at,
			updated_at
		)
		VALUES (
			'secret-bucket-a',
			'api-key',
			'API key',
			'encrypted-secret-value',
			'["api.example.com"]',
			'["fetch"]',
			'["@user/pkg"]',
			'lookup-hash',
			'2026-07-05',
			'2026-07-05'
		);

		INSERT INTO value_buckets (id, user_id, scope, binding_key, created_at, updated_at)
		VALUES ('value-bucket-a', 'user-aaa', 'user', 'global', '2026-07-05', '2026-07-05');
		INSERT INTO value_entries (bucket_id, name, description, value, created_at, updated_at)
		VALUES ('value-bucket-a', 'timezone', 'Preferred timezone', 'America/Denver', '2026-07-05', '2026-07-05');

		INSERT INTO package_invocation_tokens (
			id,
			user_id,
			name,
			token_hash,
			email,
			display_name,
			created_at,
			updated_at
		)
		VALUES (
			'token-a',
			'user-aaa',
			'Migration token',
			'token-hash-a',
			'a@example.com',
			'User A',
			'2026-07-05',
			'2026-07-05'
		);

		INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
		VALUES (1, 1, 'reset-token-hash-a', 2000000000, '2026-07-05');

		INSERT INTO remote_connector_settings (
			id,
			user_id,
			kind,
			instance_id,
			encrypted_shared_secret,
			created_at,
			updated_at
		)
		VALUES (
			'connector-a',
			'user-aaa',
			'home',
			'default',
			'encrypted-connector-secret',
			'2026-07-05',
			'2026-07-05'
		);

		INSERT INTO mcp_memories (id, user_id, subject, summary, details)
		VALUES
			('memory-a', 'user-aaa', 'Favorite color', 'Blue', 'Likes navy.'),
			('memory-b', 'user-bbb', 'Favorite color', 'Green', 'Likes moss.');
	`)
	const accountExport = await createAccountExport({
		env: {
			APP_DB: db,
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({
					exportStorage: async () => ({
						entries: [],
						estimatedBytes: 0,
						truncated: false,
						nextStartAfter: null,
						pageSize: 500,
					}),
				}),
			},
		} as unknown as Env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		generatedAt: '2026-07-05T00:00:00.000Z',
	})

	expect(accountExport.manifest.security.secretValuesExported).toBe(false)
	expect(accountExport.d1.users.rows).toEqual([
		expect.not.objectContaining({ password_hash: expect.anything() }),
	])
	expect(accountExport.d1.secret_entries.rows).toEqual([
		expect.objectContaining({
			bucket_id: 'secret-bucket-a',
			name: 'api-key',
			allowed_hosts: '["api.example.com"]',
			allowed_capabilities: '["fetch"]',
			allowed_packages: '["@user/pkg"]',
		}),
	])
	expect(accountExport.d1.secret_entries.rows[0]).not.toHaveProperty(
		'encrypted_value',
	)
	expect(accountExport.d1.secret_entries.rows[0]).not.toHaveProperty(
		'lookup_hash',
	)
	expect(accountExport.d1.package_invocation_tokens.rows[0]).not.toHaveProperty(
		'token_hash',
	)
	expect(accountExport.d1.password_resets.rows[0]).not.toHaveProperty(
		'token_hash',
	)
	expect(accountExport.d1.remote_connector_settings.rows[0]).toEqual(
		expect.objectContaining({
			id: 'connector-a',
			kind: 'home',
			instance_id: 'default',
		}),
	)
	expect(accountExport.d1.remote_connector_settings.rows[0]).not.toHaveProperty(
		'encrypted_shared_secret',
	)
	expect(accountExport.d1.value_entries.rows).toEqual([
		expect.objectContaining({ value: 'America/Denver' }),
	])
	expect(accountExport.d1.mcp_memories.rows).toEqual([
		expect.objectContaining({ id: 'memory-a', summary: 'Blue' }),
	])
	expect(
		accountExport.d1.mcp_memories.rows.some((row) => row.id === 'memory-b'),
	).toBe(false)
	expect(
		accountExport.manifest.sections['d1.secret_entries']?.redactedColumns,
	).toEqual(['encrypted_value', 'lookup_hash'])
	expect(
		accountExport.manifest.sections['d1.remote_connector_settings']
			?.redactedColumns,
	).toEqual(['encrypted_shared_secret'])
})

test('createAccountExport records partial-failure warnings and section pagination works', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (id, username, email, password_hash, created_at, updated_at, email_verified_at)
		VALUES (1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05', '2026-07-05', '2026-07-05');
		INSERT INTO archived_job_artifacts (
			id,
			job_id,
			user_id,
			source_id,
			published_commit,
			storage_id,
			retain_until,
			created_at,
			updated_at
		)
		VALUES (
			'archive-a',
			'job-a',
			'user-aaa',
			'source-a',
			'commit-a',
			'job:archive-a',
			'2026-08-05',
			'2026-07-05',
			'2026-07-05'
		);
		INSERT INTO value_buckets (id, user_id, scope, binding_key, created_at, updated_at)
		VALUES ('value-bucket-a', 'user-aaa', 'user', 'global', '2026-07-05', '2026-07-05');
		INSERT INTO value_entries (bucket_id, name, description, value, created_at, updated_at)
		VALUES
			('value-bucket-a', 'first', '', '1', '2026-07-05', '2026-07-05'),
			('value-bucket-a', 'second', '', '2', '2026-07-05', '2026-07-05');
	`)
	const exportStorage = vi.fn(async () => {
		throw new Error('storage unavailable')
	})
	const env = {
		APP_DB: db,
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ exportStorage }),
		},
		OAUTH_PROVIDER: {
			async listUserGrants() {
				throw new Error('oauth unavailable')
			},
		},
	} as unknown as Env & {
		OAUTH_PROVIDER: {
			listUserGrants: () => Promise<never>
		}
	}

	const accountExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		generatedAt: '2026-07-05T00:00:00.000Z',
	})
	expect(accountExport.manifest.warnings).toEqual(
		expect.arrayContaining([
			expect.stringContaining('Storage runner export failed for job:archive-a'),
			expect.stringContaining('OAuth grant listing failed'),
		]),
	)

	const page = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'd1_table',
		table: 'value_entries',
		pageSize: 1,
	})
	expect(page.items).toHaveLength(1)
	expect(page.truncated).toBe(true)
	expect(page.nextStartAfter).toBe('value-bucket-a:first')
	const nextPage = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'd1_table',
		table: 'value_entries',
		pageSize: 1,
		startAfter: page.nextStartAfter ?? undefined,
	})
	expect(nextPage.items).toEqual([expect.objectContaining({ name: 'second' })])
	expect(nextPage.truncated).toBe(false)
})
