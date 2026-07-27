import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	normalizeOpenApiBinding,
	type OpenApiBinding,
} from './binding-shared.ts'
import { getOpenApiBinding } from './binding-service.ts'

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const openApiBindingsMigration = '0102-user-openapi-bindings.sql'

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

/** D1 wraps each migration file in a transaction. */
function applyMigrationLikeD1(db: DatabaseSync, fileName: string) {
	const sql = readFileSync(new URL(fileName, migrationsDirectory), 'utf8')
	db.exec('BEGIN')
	try {
		db.exec(sql)
		db.exec('COMMIT')
	} catch (error) {
		db.exec('ROLLBACK')
		throw error
	}
}

function insertUserBucket(
	db: DatabaseSync,
	input: { bucketId: string; userId: string },
) {
	db.prepare(
		`INSERT INTO value_buckets (
			id, user_id, scope, binding_key, expires_at, created_at, updated_at
		) VALUES (?, ?, 'user', '', NULL, ?, ?)`,
	).run(
		input.bucketId,
		input.userId,
		'2026-01-01T00:00:00.000Z',
		'2026-01-01T00:00:00.000Z',
	)
}

function insertValue(
	db: DatabaseSync,
	input: {
		bucketId: string
		name: string
		value: string
		createdAt?: string
		updatedAt?: string
	},
) {
	db.prepare(
		`INSERT INTO value_entries (
			bucket_id, name, description, value, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?)`,
	).run(
		input.bucketId,
		input.name,
		'OpenAPI provider binding',
		input.value,
		input.createdAt ?? '2026-02-01T00:00:00.000Z',
		input.updatedAt ?? '2026-02-02T00:00:00.000Z',
	)
}

function listOpenApiValueNames(db: DatabaseSync, userId: string) {
	return (
		db
			.prepare(
				`SELECT e.name
				FROM value_entries e
				INNER JOIN value_buckets b ON b.id = e.bucket_id
				WHERE b.user_id = ? AND e.name GLOB '_openapi:*'
				ORDER BY e.name ASC`,
			)
			.all(userId) as Array<{ name: string }>
	).map((row) => row.name)
}

function sampleOperation(slug: string, path: string) {
	return {
		slug,
		operationId: slug,
		method: 'get' as const,
		path,
		summary: `${slug} summary`,
		description: null,
		tags: ['widgets'],
		deprecated: false,
		parameters: [],
		requestBody: null,
	}
}

function sampleBinding(overrides?: Partial<OpenApiBinding>): OpenApiBinding {
	const operations = (
		overrides?.operations ?? [
			sampleOperation('listwidgets', '/widgets'),
			sampleOperation('getwidget', '/widgets/{id}'),
			sampleOperation('createwidget', '/widgets'),
		]
	)
		.slice()
		.sort((left, right) => left.slug.localeCompare(right.slug, 'en'))
	return normalizeOpenApiBinding({
		name: 'widgets',
		specUrl: 'https://specs.example/openapi.json',
		apiBaseUrl: 'https://api.widgets.example',
		description: 'Widgets API binding',
		auth: { kind: 'none' },
		selection: { tags: ['widgets'] },
		includeDestructive: false,
		specTitle: 'Widgets API',
		specVersion: '1.0.0',
		updatedAt: '2026-07-01T12:00:00.000Z',
		...overrides,
		operations,
	})
}

test('0102 migrates a valid _openapi binding with exploded operations', async () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, openApiBindingsMigration)

	insertUserBucket(db, { bucketId: 'bucket-a', userId: 'user-a' })
	const binding = sampleBinding({
		name: 'widgets',
		includeDestructive: true,
		auth: { kind: 'bearerSecret', secretName: 'widgetToken' },
		description: '  curated widgets  ',
		specTitle: '  Widgets API  ',
		specVersion: '  1.0.0  ',
	})
	insertValue(db, {
		bucketId: 'bucket-a',
		name: '_openapi:widgets',
		value: JSON.stringify(binding),
		createdAt: '2026-03-01T00:00:00.000Z',
		updatedAt: '2026-03-02T00:00:00.000Z',
	})
	insertValue(db, {
		bucketId: 'bucket-a',
		name: 'unrelated-config',
		value: '{"keep":true}',
	})

	applyMigration(db, openApiBindingsMigration)

	expect(listOpenApiValueNames(db, 'user-a')).toEqual([])
	expect(
		db
			.prepare(
				`SELECT name FROM value_entries e
				INNER JOIN value_buckets b ON b.id = e.bucket_id
				WHERE b.user_id = 'user-a'
				ORDER BY name ASC`,
			)
			.all(),
	).toEqual([{ name: 'unrelated-config' }])

	const bindingRow = db
		.prepare(
			`SELECT user_id, name, spec_url, api_base_url, description, auth_json,
				selection_json, include_destructive, spec_title, spec_version,
				created_at, updated_at
			FROM user_openapi_bindings
			WHERE user_id = 'user-a' AND name = 'widgets'`,
		)
		.get() as {
		user_id: string
		name: string
		spec_url: string
		api_base_url: string
		description: string | null
		auth_json: string
		selection_json: string
		include_destructive: number
		spec_title: string | null
		spec_version: string | null
		created_at: string
		updated_at: string
	}

	expect(bindingRow).toMatchObject({
		user_id: 'user-a',
		name: 'widgets',
		spec_url: binding.specUrl,
		api_base_url: binding.apiBaseUrl,
		description: 'curated widgets',
		include_destructive: 1,
		spec_title: 'Widgets API',
		spec_version: '1.0.0',
		created_at: '2026-03-01T00:00:00.000Z',
		updated_at: '2026-07-01T12:00:00.000Z',
	})
	expect(JSON.parse(bindingRow.auth_json)).toEqual({
		kind: 'bearerSecret',
		secretName: 'widgetToken',
	})
	expect(JSON.parse(bindingRow.selection_json)).toEqual({
		tags: ['widgets'],
	})

	const operations = db
		.prepare(
			`SELECT slug, operation_json
			FROM user_openapi_binding_operations
			WHERE user_id = 'user-a' AND binding_name = 'widgets'
			ORDER BY slug ASC`,
		)
		.all() as Array<{ slug: string; operation_json: string }>

	expect(operations.map((row) => row.slug)).toEqual([
		'createwidget',
		'getwidget',
		'listwidgets',
	])
	expect(operations).toHaveLength(3)
	for (const row of operations) {
		const parsed = JSON.parse(row.operation_json) as { slug: string }
		expect(parsed.slug).toBe(row.slug)
	}

	const expected = sampleBinding({
		name: 'widgets',
		includeDestructive: true,
		auth: { kind: 'bearerSecret', secretName: 'widgetToken' },
		description: 'curated widgets',
		specTitle: 'Widgets API',
		specVersion: '1.0.0',
	})
	const d1 = createD1FromSqlite(db)
	const loaded = await getOpenApiBinding({
		env: { APP_DB: d1 },
		userId: 'user-a',
		name: 'widgets',
	})
	expect(loaded).toEqual(expected)
})

function expectMigrationAbortPreservesValues(
	db: DatabaseSync,
	userId: string,
	beforeNames: Array<string>,
) {
	expect(() => applyMigrationLikeD1(db, openApiBindingsMigration)).toThrow(
		/CHECK constraint failed: 0/,
	)
	expect(listOpenApiValueNames(db, userId)).toEqual(beforeNames)
	expect(
		db
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table'
				   AND name IN (
						'user_openapi_bindings',
						'user_openapi_binding_operations',
						'__migration_assertions'
					)`,
			)
			.all(),
	).toEqual([])
}

test('0102 aborts when a non-migratable _openapi value row exists', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, openApiBindingsMigration)

	insertUserBucket(db, { bucketId: 'bucket-abort', userId: 'user-abort' })
	insertValue(db, {
		bucketId: 'bucket-abort',
		name: '_openapi:widgets',
		value: JSON.stringify(sampleBinding()),
	})
	// Missing operations array → fails migratable predicate.
	insertValue(db, {
		bucketId: 'bucket-abort',
		name: '_openapi:broken',
		value: JSON.stringify({
			name: 'broken',
			specUrl: 'https://specs.example/openapi.json',
			apiBaseUrl: 'https://api.example',
			auth: { kind: 'none' },
			selection: { tags: ['x'] },
			includeDestructive: false,
			specTitle: null,
			specVersion: null,
			updatedAt: '2026-07-01T00:00:00.000Z',
		}),
	})

	const beforeNames = listOpenApiValueNames(db, 'user-abort')
	expect(beforeNames).toEqual(['_openapi:broken', '_openapi:widgets'])
	expectMigrationAbortPreservesValues(db, 'user-abort', beforeNames)
})

test('0102 aborts when an operation is missing a slug', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, openApiBindingsMigration)

	insertUserBucket(db, { bucketId: 'bucket-noslug', userId: 'user-noslug' })
	const binding = sampleBinding({ name: 'noslug' })
	insertValue(db, {
		bucketId: 'bucket-noslug',
		name: '_openapi:noslug',
		value: JSON.stringify({
			...binding,
			operations: [
				binding.operations[0],
				{
					...binding.operations[1],
					slug: '',
				},
			],
		}),
	})

	const beforeNames = listOpenApiValueNames(db, 'user-noslug')
	expect(beforeNames).toEqual(['_openapi:noslug'])
	expectMigrationAbortPreservesValues(db, 'user-noslug', beforeNames)
})

test('0102 aborts when operations contain duplicate slugs', () => {
	const db = new DatabaseSync(':memory:')
	applyMigrationsBefore(db, openApiBindingsMigration)

	insertUserBucket(db, { bucketId: 'bucket-dup', userId: 'user-dup' })
	const binding = sampleBinding({ name: 'dupes' })
	insertValue(db, {
		bucketId: 'bucket-dup',
		name: '_openapi:dupes',
		value: JSON.stringify({
			...binding,
			operations: [
				binding.operations[0],
				{ ...binding.operations[1], slug: binding.operations[0]!.slug },
			],
		}),
	})

	const beforeNames = listOpenApiValueNames(db, 'user-dup')
	expect(beforeNames).toEqual(['_openapi:dupes'])
	expectMigrationAbortPreservesValues(db, 'user-dup', beforeNames)
})
