import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	clearCachedPackageAppCustomHostnames,
	invalidateCachedPackageAppCustomHostname,
	lookupCachedPackageAppCustomHostname,
} from './lookup-cache.ts'

const migrationSql = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../../migrations/0133-package-app-custom-hostnames.sql',
	),
	'utf8',
)

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE orgs (
			id TEXT PRIMARY KEY,
			slug TEXT,
			suspended_at TEXT,
			deleted_at TEXT
		);
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			deleted_at TEXT
		);
	`)
	sqlite.exec(migrationSql)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('cached lookup returns the same mapping within the TTL and refreshes after invalidate', async () => {
	const { sqlite, db } = createDb()
	clearCachedPackageAppCustomHostnames(db)
	await db
		.prepare(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'acme')`)
		.run()
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, created_by_user_id,
				created_at, updated_at
			) VALUES (
				'row-1', 'apps.example.com', 'org', NULL, 'org-1',
				'cf-1', 'zone', 'active', 'active', 'person-1',
				'2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'
			)`,
		)
		.run()

	const first = await lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'Apps.Example.com',
	})
	expect(first?.hostname).toBe('apps.example.com')
	expect(first?.verified).toBe(true)

	sqlite
		.prepare(
			`UPDATE package_app_custom_hostnames SET hostname_status = 'moved' WHERE id = 'row-1'`,
		)
		.run()
	const cached = await lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'apps.example.com',
	})
	expect(cached?.hostnameStatus).toBe('active')

	invalidateCachedPackageAppCustomHostname(db, 'apps.example.com')
	const refreshed = await lookupCachedPackageAppCustomHostname({
		db,
		hostname: 'apps.example.com',
	})
	expect(refreshed?.hostnameStatus).toBe('moved')
	expect(refreshed?.verified).toBe(false)
})

test('cached lookup stores negative misses', async () => {
	const { db } = createDb()
	clearCachedPackageAppCustomHostnames(db)
	expect(
		await lookupCachedPackageAppCustomHostname({
			db,
			hostname: 'missing.example.com',
		}),
	).toBeNull()
	expect(
		await lookupCachedPackageAppCustomHostname({
			db,
			hostname: 'missing.example.com',
		}),
	).toBeNull()
})
