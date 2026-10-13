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
	syncPackageAppCustomHostname,
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

function cfHostnameResponse(
	overrides: {
		id?: string
		hostname?: string
		status?: string
		sslStatus?: string
		method?: string
	} = {},
) {
	return new Response(
		JSON.stringify({
			success: true,
			result: {
				id: overrides.id ?? 'cf-1',
				hostname: overrides.hostname ?? 'team.example.com',
				status: overrides.status ?? 'pending',
				ownership_verification: {
					type: 'txt',
					name: '_cf-custom-hostname.team.example.com',
					value: 'ownership-token',
				},
				ssl: {
					status: overrides.sslStatus ?? 'pending_validation',
					validation_records: [
						{
							txt_name: '_acme-challenge.team.example.com',
							txt_value: 'ssl-token',
						},
					],
				},
			},
		}),
		{ status: 200 },
	)
}

test('add rejects app-level hostnames for non-internet-visible packages', async () => {
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
	vi.spyOn(packageRepo, 'getSavedPackageById').mockResolvedValue({
		id: 'pkg-1',
		userId: 'org-1',
		name: '@acme/demo',
		isInternetVisible: false,
	} as Awaited<ReturnType<typeof packageRepo.getSavedPackageById>>)

	const fetcher = {
		fetch: vi.fn(async () => cfHostnameResponse()),
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

test('add rejects free-plan orgs before calling Cloudflare', async () => {
	const db = createDb()
	await db
		.prepare(
			`INSERT INTO feature_flags (key, enabled) VALUES ('package-app-custom-domains', 1)`,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO orgs (id, slug, suspended_at, deleted_at, stripe_plan) VALUES ('org-1', 'acme', NULL, NULL, 'free')`,
		)
		.run()

	const fetcher = {
		fetch: vi.fn(async () => cfHostnameResponse()),
	} as unknown as Fetcher

	await expect(
		addPackageAppCustomHostname({
			env: { ...createEnv(db), fetcher } as unknown as Env,
			orgId: 'org-1',
			createdByUserId: 'person-1',
			bindingKind: 'org',
			hostname: 'team.example.com',
		}),
	).rejects.toThrow(/paid organization plan/)
	expect(fetcher.fetch).not.toHaveBeenCalled()
})

test('add stores org binding with verification records and list returns it', async () => {
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
		fetch: vi.fn(async (url: string, init?: RequestInit) => {
			if (init?.method === 'DELETE') {
				return cfHostnameResponse({ status: 'deleted' })
			}
			return cfHostnameResponse({
				id: 'cf-org',
				hostname: 'team.example.com',
			})
		}),
	} as unknown as Fetcher

	const added = await addPackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		createdByUserId: 'person-1',
		bindingKind: 'org',
		hostname: 'team.example.com',
		sslMethod: 'txt',
	})
	expect(added.hostname.hostname).toBe('team.example.com')
	expect(added.dns.target).toBe('kody.run')
	expect(added.verification.ownership_verification?.value).toBe(
		'ownership-token',
	)
	expect(added.verification.ssl_validation_records[0]?.value).toBe('ssl-token')
	expect(
		JSON.parse(
			String(
				(fetcher.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body,
			),
		),
	).toMatchObject({
		ssl: { method: 'txt', type: 'dv' },
	})

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

test('sync refreshes Cloudflare status and returns verification records', async () => {
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
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, created_by_user_id,
				created_at, updated_at
			) VALUES (
				'row-1', 'team.example.com', 'org', NULL, 'org-1',
				'cf-org', 'zonetest123', 'pending', 'pending', 'person-1',
				'2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'
			)`,
		)
		.run()

	const fetcher = {
		fetch: vi.fn(async () =>
			cfHostnameResponse({
				id: 'cf-org',
				hostname: 'team.example.com',
				status: 'active',
				sslStatus: 'active',
			}),
		),
	} as unknown as Fetcher

	const synced = await syncPackageAppCustomHostname({
		env: { ...createEnv(db), fetcher } as unknown as Env,
		orgId: 'org-1',
		id: 'row-1',
		now: new Date('2026-10-13T12:00:00.000Z'),
	})
	expect(synced.hostname.hostname_status).toBe('active')
	expect(synced.hostname.ssl_status).toBe('active')
	expect(synced.hostname.verified_at).toBe('2026-10-13T12:00:00.000Z')
	expect(synced.verification.ownership_verification?.name).toBe(
		'_cf-custom-hostname.team.example.com',
	)
})

test('add compensates with Cloudflare delete when the local insert fails', async () => {
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
	await db
		.prepare(
			`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status, created_by_user_id,
				created_at, updated_at
			) VALUES (
				'existing', 'team.example.com', 'org', NULL, 'org-1',
				'cf-old', 'zonetest123', 'pending', 'pending', 'person-1',
				'2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z'
			)`,
		)
		.run()

	const methods: Array<string> = []
	const fetcher = {
		fetch: vi.fn(async (_url: string, init?: RequestInit) => {
			methods.push(init?.method ?? 'GET')
			if (init?.method === 'DELETE') {
				return cfHostnameResponse({ id: 'cf-new', status: 'deleted' })
			}
			return cfHostnameResponse({ id: 'cf-new', hostname: 'team.example.com' })
		}),
	} as unknown as Fetcher

	await expect(
		addPackageAppCustomHostname({
			env: { ...createEnv(db), fetcher } as unknown as Env,
			orgId: 'org-1',
			createdByUserId: 'person-1',
			bindingKind: 'org',
			hostname: 'team.example.com',
		}),
	).rejects.toThrow(/could not be stored/)
	expect(methods).toEqual(['POST', 'DELETE'])
})
