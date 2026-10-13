import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'
import { buildPackageAppNotFoundMessage } from '#worker/package-runtime/package-app-synthetic.ts'
import { packageAppCustomDomainsFlagKey } from '#worker/package-app-custom-hostnames/feature-flag.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import {
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const appOrigin = 'https://app.kody.test:8788'
const packageAppOrigin = 'https://packages.isolated.test'
const ownerEmail = 'custom-host-owner@example.com'
const ownerUsername = 'customhost'
const customHostname = 'app.customer-test.example'
const customOrigin = `https://${customHostname}`
const packageId = 'pkg-custom-demo'
const ownerPackageAppOrigin = `https://${ownerUsername}.packages.isolated.test`

function configureOrigins() {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = appOrigin
	mutableEnv.PACKAGE_APP_BASE_URL = packageAppOrigin
	mutableEnv.SENTRY_ENVIRONMENT = 'production'
}

async function workerFetch(url: string | URL, init: RequestInit = {}) {
	return await exports.default.fetch(
		new Request(url, { redirect: 'manual', ...init }),
	)
}

async function seedOwnerSessionCookie() {
	await ensureRbacTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE users ADD COLUMN password_changed_at TEXT`,
		).run()
	} catch {
		// Column already present from an earlier seed in this suite.
	}
	for (const statement of [
		`CREATE TABLE IF NOT EXISTS permissions (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			action TEXT NOT NULL,
			entity TEXT NOT NULL,
			access TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS role_permissions (
			role_id INTEGER NOT NULL,
			permission_id INTEGER NOT NULL,
			PRIMARY KEY (role_id, permission_id)
		)`,
	]) {
		await env.APP_DB.prepare(statement).run()
	}
	await seedAccount({
		db: env.APP_DB,
		email: ownerEmail,
		username: ownerUsername,
	})
	setAuthSessionSecret(env.COOKIE_SECRET)
	const setCookie = await createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail(ownerEmail),
			email: ownerEmail,
			rememberMe: false,
		},
		true,
	)
	return setCookie.split(';')[0] ?? ''
}

async function ensureCustomHostnameSchema() {
	// Workers-unit D1 starts empty; suites create the tables they touch.
	// Production applies migration 0128. CREATE IF NOT EXISTS covers both.
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS feature_flags (
			key TEXT PRIMARY KEY NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 0,
			rollout_percent INTEGER,
			note TEXT NOT NULL DEFAULT '',
			audience TEXT NOT NULL DEFAULT 'everyone',
			updated_by INTEGER,
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS package_app_custom_hostnames (
			id TEXT PRIMARY KEY NOT NULL,
			hostname TEXT NOT NULL,
			binding_kind TEXT NOT NULL CHECK (binding_kind IN ('app', 'org')),
			package_id TEXT,
			org_id TEXT,
			cloudflare_hostname_id TEXT,
			cloudflare_zone_id TEXT,
			hostname_status TEXT NOT NULL DEFAULT 'pending',
			ssl_status TEXT NOT NULL DEFAULT 'pending',
			verified_at TEXT,
			dns_missing_since TEXT,
			created_by_user_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			CHECK (
				(
					binding_kind = 'app'
					AND package_id IS NOT NULL
					AND org_id IS NULL
				)
				OR (
					binding_kind = 'org'
					AND org_id IS NOT NULL
					AND package_id IS NULL
				)
			),
			CHECK (hostname = lower(hostname)),
			FOREIGN KEY (package_id) REFERENCES saved_packages (id) ON DELETE CASCADE,
			FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE UNIQUE INDEX IF NOT EXISTS package_app_custom_hostnames_hostname_idx
			ON package_app_custom_hostnames (hostname)`,
	).run()
}

async function seedCustomHostnamePackage() {
	await ensureCustomHostnameSchema()
	const ownerId = testStableUserIdFromEmail(ownerEmail)
	const now = '2026-10-13T00:00:00.000Z'
	await env.APP_DB.prepare(
		`DELETE FROM package_app_custom_hostnames WHERE hostname = ?`,
	)
		.bind(customHostname)
		.run()
	await env.APP_DB.prepare(`DELETE FROM saved_packages WHERE id = ?`)
		.bind(packageId)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 1, 0, 1, ?, ?)`,
	)
		.bind(
			packageId,
			ownerId,
			`@${ownerUsername}/demo`,
			'demo',
			'Custom hostname package.',
			`source-${packageId}`,
			now,
			now,
		)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO package_app_custom_hostnames (
			id, hostname, binding_kind, package_id, org_id,
			hostname_status, ssl_status, verified_at, created_at, updated_at
		) VALUES (?, ?, 'app', ?, NULL, 'active', 'active', ?, ?, ?)`,
	)
		.bind(`host-${packageId}`, customHostname, packageId, now, now, now)
		.run()
}

async function setCustomDomainsFlag(enabled: boolean) {
	await ensureCustomHostnameSchema()
	await env.APP_DB.prepare(
		`INSERT INTO feature_flags (key, enabled, note, audience, updated_at)
		 VALUES (?, ?, '', 'everyone', CURRENT_TIMESTAMP)
		 ON CONFLICT(key) DO UPDATE SET
			enabled = excluded.enabled,
			updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(packageAppCustomDomainsFlagKey, enabled ? 1 : 0)
		.run()
}

test('custom hostnames stay refused and handoff stays on the user subdomain when the flag is off', async () => {
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	await seedCustomHostnamePackage()
	await setCustomDomainsFlag(false)

	const customHost = await workerFetch(`${customOrigin}/`)
	expect(customHost.status).toBe(404)
	await expect(customHost.json()).resolves.toEqual({ error: 'not_found' })

	const appOriginResponse = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo`,
		{ headers: { Cookie: sessionCookie } },
	)
	expect(appOriginResponse.status).toBe(302)
	const location = new URL(appOriginResponse.headers.get('Location') ?? '')
	expect(location.origin).toBe(ownerPackageAppOrigin)
	expect(location.pathname).toBe('/packages/demo')
	expect(location.searchParams.get(packageAppHandoffQueryParam)).toBeTruthy()
})

test('a verified app custom hostname serves at / behind the same host-only handoff', async () => {
	silenceExpectedConsoleErrors([
		'Package app handler failed:',
		'package-app-http-error',
	])
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	await seedCustomHostnamePackage()
	await setCustomDomainsFlag(true)
	const entryUrl = `${appOrigin}/@${ownerUsername}/packages/demo`

	const missingSession = await workerFetch(`${customOrigin}/`)
	expect(missingSession.status).toBe(403)
	expect(missingSession.headers.get('X-Kody-Handoff')).toBe('required')
	const missingSessionBody = await missingSession.text()
	expect(missingSessionBody).toContain(entryUrl)

	const appOriginResponse = await workerFetch(entryUrl, {
		headers: { Cookie: sessionCookie },
	})
	expect(appOriginResponse.status).toBe(302)
	const handoffLocation = new URL(
		appOriginResponse.headers.get('Location') ?? '',
	)
	expect(handoffLocation.origin).toBe(customOrigin)
	expect(handoffLocation.pathname).toBe('/')
	expect(
		handoffLocation.searchParams.get(packageAppHandoffQueryParam),
	).toBeTruthy()
	expect(handoffLocation.host).not.toContain(ownerUsername)

	const handoffResponse = await workerFetch(handoffLocation)
	expect(handoffResponse.status).toBe(302)
	const setCookie = handoffResponse.headers.get('Set-Cookie') ?? ''
	expect(setCookie).toContain('__Host-kody_pkg_session=')
	expect(setCookie).not.toContain('Domain=')
	const cleanLocation = new URL(handoffResponse.headers.get('Location') ?? '')
	expect(cleanLocation.origin).toBe(customOrigin)
	expect(cleanLocation.pathname).toBe('/')
	expect(cleanLocation.searchParams.has(packageAppHandoffQueryParam)).toBe(
		false,
	)

	const packageSessionCookie = setCookie.split(';')[0] ?? ''
	const served = await workerFetch(`${customOrigin}/`, {
		headers: { Cookie: packageSessionCookie },
	})
	expect(served.status).not.toBe(403)
	expect(served.headers.get('X-Kody-Handoff')).toBeNull()
	expect(served.headers.get('Location')).toBeNull()
	const servedBody = await served.text()
	expect(
		servedBody === buildPackageAppNotFoundMessage() || served.status === 500,
	).toBe(true)

	await setCustomDomainsFlag(false)
})
