import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import * as packageRepo from '#worker/package-registry/repo.ts'
import {
	addPackageAppCustomHostname,
	deletePackageAppCustomHostname,
	listPackageAppCustomHostnames,
	PackageAppCustomHostnameError,
} from './service.ts'

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
			deleted_at TEXT,
			stripe_plan TEXT
		);
		CREATE TABLE saved_packages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			deleted_at TEXT,
			is_internet_visible INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE feature_flags (
			key TEXT PRIMARY KEY,
			enabled INTEGER NOT NULL
		);
	`)
	sqlite.exec(migrationSql)
	return createD1FromSqlite(sqlite)
}

function createEnv(db: D1Database) {
	return {
		APP_DB: db,
		PACKAGE_APP_BASE_URL: 'https://kody.run',
		PACKAGE_APP_ZONE_ID: 'zonetest123',
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: 'token',
	} as unknown as Env
}

test('add rejects app-level hostnames for non-internet-visible packages', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	vi.spyOn(packageRepo, 'getSavedPackageById').mockResolvedValue({
		id: 'pkg-1',
		userId: 'org-1',
		name: '@acme/demo',
		isInternetVisible: false,
	} as Awaited<ReturnType<typeof packageRepo.getSavedPackageById>>)

	const fetcher = {
		fetch: vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'cf-1',
							hostname: 'app.example.com',
							status: 'pending',
							ssl: { status: 'pending' },
						},
					}),
					{ status: 200 },
				),
		),
	} as unknown as Fetcher

	await expect(
		addPackageAppCustomHostname({
			env: { ...createEnv(db), fetcher } as unknown as Env,
			orgId: 'org-1',
			createdByUserId: 'person-1',
			bindingKind: 'app',
			hostname: 'app.example.com',
			packageId: 'pkg-1',
		}),
	).rejects.toThrow(PackageAppCustomHostnameError)
	expect(fetcher.fetch).not.toHaveBeenCalled()
})

test('add stores org binding and list returns it', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'pro')`,
		)
		.run()

	const fetcher = {
		fetch: vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						result: {
							id: 'cf-org',
							hostname: 'team.example.com',
							status: 'pending',
							ssl: { status: 'pending' },
						},
					}),
					{ status: 200 },
				),
		),
	} as unknown as Fetcher

	const added = await addPackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		createdByUserId: 'person-1',
		bindingKind: 'org',
		hostname: 'team.example.com',
	})
	expect(added.hostname.hostname).toBe('team.example.com')
	expect(added.dns.target).toBe('kody.run')

	const listed = await listPackageAppCustomHostnames({
		env: createEnv(db),
		orgId: 'org-1',
	})
	expect(listed.hostnames).toHaveLength(1)

	await deletePackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		hostname: 'team.example.com',
	})
	expect(
		await listPackageAppCustomHostnames({ env: createEnv(db), orgId: 'org-1' }),
	).toEqual({ hostnames: [] })
})
