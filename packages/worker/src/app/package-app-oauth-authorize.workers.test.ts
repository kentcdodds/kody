import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { createS256CodeChallenge } from '#app/package-app-oauth-pkce-cookie.ts'
import {
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureAuditEventsTestSchema } from '#worker/test-support/audit-events-test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const appOrigin = 'https://app.kody.test:8788'
const packageAppOrigin = 'https://packages.isolated.test'
const ownerEmail = 'pkg-oauth-owner@example.com'
const ownerUsername = 'pkgoauth'

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

async function ensureOauthGrantSchema() {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS package_app_oauth_grants (
			id TEXT PRIMARY KEY NOT NULL,
			person_id TEXT NOT NULL,
			org_username TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			scopes TEXT NOT NULL,
			created_at TEXT NOT NULL,
			revoked_at TEXT
		)`,
	).run()
}

async function seedOwnerSessionCookie() {
	await ensureAuditEventsTestSchema(env.AUDIT_DB)
	await ensureRbacTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	await ensureOauthGrantSchema()
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

test('package-app OAuth authorize refuses unallowlisted redirect_uri', async () => {
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	const verifier = 'oauth-workers-test-verifier-32chars!!'
	const challenge = await createS256CodeChallenge(verifier)
	const url = new URL(packageAppOauthPaths.authorize, appOrigin)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', `${ownerUsername}/demo`)
	url.searchParams.set(
		'redirect_uri',
		'https://evil.example/_kody/auth/callback',
	)
	url.searchParams.set('state', 'state-1')
	url.searchParams.set('code_challenge', challenge)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('scope', 'profile')

	const response = await workerFetch(url, {
		headers: { Cookie: sessionCookie },
	})
	expect(response.status).toBe(400)
	await expect(response.text()).resolves.toMatch(/redirect_uri/)
})

test('package-app OAuth authorize shows consent for email scope', async () => {
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	const verifier = 'oauth-workers-test-verifier-32chars!!'
	const challenge = await createS256CodeChallenge(verifier)
	const redirectUri = `https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.callback}`
	const url = new URL(packageAppOauthPaths.authorize, appOrigin)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', `${ownerUsername}/demo`)
	url.searchParams.set('redirect_uri', redirectUri)
	url.searchParams.set('state', 'state-2')
	url.searchParams.set('code_challenge', challenge)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('scope', 'email')

	const response = await workerFetch(url, {
		headers: { Cookie: sessionCookie },
	})
	const body = await response.text()
	expect(response.status).toBe(200)
	expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
	expect(body).toMatch(/package-app-oauth-consent/)
	expect(body).toContain('See your email address')
	expect(body).toContain('Allow')
})
