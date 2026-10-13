import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	packageAppCustomHostnameGracePeriodMs,
	reconcilePackageAppCustomHostnames,
} from './reconcile.ts'

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
	return createD1FromSqlite(sqlite)
}

test('reconcile removes hostnames after the dns_missing grace period', async () => {
	const db = createDb()
	const created = '2026-10-10T00:00:00.000Z'
	const missingSince = new Date(
		Date.parse('2026-10-13T12:00:00.000Z') -
			packageAppCustomHostnameGracePeriodMs -
			60_000,
	).toISOString()
	await db.prepare(`INSERT INTO orgs (id, slug) VALUES ('org-1', 'team')`).run()
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, verified_at, dns_missing_since,
				created_at, updated_at
			) VALUES (
				'row-1', 'gone.example.com', 'org', NULL, 'org-1',
				'cf-1', 'zone1',
				'moved', 'deleted', ?, ?,
				?, ?
			)`,
		)
		.bind(created, missingSince, created, created)
		.run()

	const fetcher = {
		fetch: vi.fn(async (request: Request) => {
			const movedBody = {
				success: true,
				result: {
					id: 'cf-1',
					hostname: 'gone.example.com',
					status: 'moved',
					ssl: { status: 'deleted' },
				},
			}
			if (request.method === 'DELETE') {
				return new Response(JSON.stringify(movedBody), { status: 200 })
			}
			return new Response(JSON.stringify(movedBody), { status: 200 })
		}),
	} as unknown as Fetcher

	const env = {
		APP_DB: db,
		PACKAGE_APP_ZONE_ID: 'zone1',
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: 'token',
		fetcher,
	} as unknown as Env

	const result = await reconcilePackageAppCustomHostnames({
		env,
		now: new Date('2026-10-13T12:00:00.000Z'),
	})
	expect(result.removed).toBe(1)
	const row = await db
		.prepare(`SELECT * FROM package_app_custom_hostnames WHERE id = 'row-1'`)
		.first()
	expect(row).toBeNull()
})
