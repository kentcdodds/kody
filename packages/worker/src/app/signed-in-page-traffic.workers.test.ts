import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { anonymousHtmlCacheControl } from '#app/anonymous-html-cache.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { ensureCommunityFlowSchema } from '#worker/community/community-flow-test-schema.ts'
import { assignUserRole } from '#worker/identity/permissions-db.ts'
import { parseServerTimingHeader } from '#worker/server-timing.ts'
import {
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'

const testerEmail = 'pageload-tester@example.com'
const testerUsername = 'pageload-tester'
const testerPassword = 'ilikecode'

const anonymousCacheablePaths = [
	'/',
	'/onboarding',
	'/onboarding.json',
	'/guides',
	'/guides/how-kody-works',
] as const

const alwaysPrivatePaths = ['/login'] as const

function createRequest(
	path: string,
	options: RequestInit & { headers?: Record<string, string> } = {},
): Request {
	return new Request(`https://test.kody.dev${path}`, options)
}

async function workerFetch(request: Request): Promise<Response> {
	const ctx = createExecutionContext()
	const response = await exports.default.fetch(
		new Request(request, { redirect: 'manual' }),
		env,
		ctx,
	)
	await waitOnExecutionContext(ctx)
	return response
}

function cookieFromSetCookie(setCookie: string | null) {
	const first = setCookie?.split(';')[0]
	if (!first?.startsWith('kody_session=')) {
		throw new Error(`Expected kody_session Set-Cookie, got ${setCookie}`)
	}
	return first
}

async function probe(path: string, cookie?: string) {
	const response = await workerFetch(
		createRequest(path, {
			headers: cookie ? { Cookie: cookie } : undefined,
		}),
	)
	const body = await response.text()
	return {
		path,
		status: response.status,
		cacheControl: response.headers.get('Cache-Control'),
		vary: response.headers.get('Vary'),
		serverTiming: parseServerTimingHeader(
			response.headers.get('Server-Timing'),
		),
		bytes: new TextEncoder().encode(body).length,
		loggedInJson:
			path.endsWith('.json') && body.includes('"loggedIn":true')
				? true
				: path.endsWith('.json') && body.includes('"loggedIn":false')
					? false
					: undefined,
		hasTesterUsername: body.includes(testerUsername),
	}
}

async function seedPageloadTester() {
	await ensureCommunityFlowSchema(env.APP_DB)
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE users ADD COLUMN email_verified_at TEXT`,
		).run()
	} catch {
		// Column already present from a prior suite sharing this D1.
	}
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE users ADD COLUMN password_changed_at TEXT`,
		).run()
	} catch {
		// Column already present from a prior suite sharing this D1.
	}
	await ensureRbacTestSchema(env.APP_DB)
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
		`CREATE TABLE IF NOT EXISTS verifications (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			type TEXT NOT NULL,
			target TEXT NOT NULL,
			secret TEXT NOT NULL,
			algorithm TEXT NOT NULL,
			digits INTEGER NOT NULL,
			period INTEGER NOT NULL,
			char_set TEXT NOT NULL,
			expires_at INTEGER,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			UNIQUE (target, type)
		)`,
		`CREATE TABLE IF NOT EXISTS feature_flags (
			key TEXT PRIMARY KEY NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 0,
			rollout_percent INTEGER,
			note TEXT NOT NULL DEFAULT '',
			updated_by INTEGER,
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE TABLE IF NOT EXISTS feature_flag_user_overrides (
			flag_key TEXT NOT NULL,
			user_id INTEGER NOT NULL,
			enabled INTEGER NOT NULL,
			updated_by INTEGER,
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (flag_key, user_id)
		)`,
	]) {
		await env.APP_DB.prepare(statement).run()
	}

	const userId = await seedAccount({
		db: env.APP_DB,
		email: testerEmail,
		username: testerUsername,
		passwordHash: await createPasswordHash(testerPassword),
	})
	await assignUserRole({
		db: env.APP_DB,
		userId,
		roleName: 'user',
	})
	return userId
}

test('signed-in page traffic stays private while shared guide JSON stays public', async () => {
	await seedPageloadTester()
	setAuthSessionSecret(env.COOKIE_SECRET)

	const anonymous = []
	for (const path of [
		...anonymousCacheablePaths,
		...alwaysPrivatePaths,
		'/guides/how-kody-works.json',
	]) {
		anonymous.push(await probe(path))
	}

	for (const path of anonymousCacheablePaths) {
		const row = anonymous.find((entry) => entry.path === path)
		expect(row?.status, path).toBe(200)
		expect(row?.cacheControl, path).toBe(anonymousHtmlCacheControl)
	}
	expect(
		anonymous.find((entry) => entry.path === '/guides/how-kody-works.json')
			?.cacheControl,
	).toBe(anonymousHtmlCacheControl)
	for (const path of alwaysPrivatePaths) {
		const row = anonymous.find((entry) => entry.path === path)
		expect(row?.status, path).toBe(200)
		expect(row?.cacheControl, path).toBe('no-store')
	}
	expect(
		anonymous.find((entry) => entry.path === '/onboarding.json')?.loggedInJson,
	).toBe(false)

	const loginResponse = await workerFetch(
		createRequest('/auth', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'CF-Connecting-IP': '203.0.113.25',
			},
			body: JSON.stringify({
				email: testerEmail,
				password: testerPassword,
				mode: 'login',
			}),
		}),
	)
	expect(loginResponse.status).toBe(200)
	await expect(loginResponse.json()).resolves.toEqual({
		ok: true,
		mode: 'login',
	})
	const sessionCookie = cookieFromSetCookie(
		loginResponse.headers.get('Set-Cookie'),
	)

	const signedIn = []
	for (const path of [
		...anonymousCacheablePaths,
		...alwaysPrivatePaths,
		'/guides/how-kody-works.json',
	]) {
		signedIn.push(await probe(path, sessionCookie))
	}

	for (const path of anonymousCacheablePaths) {
		const row = signedIn.find((entry) => entry.path === path)
		expect(row?.status, path).toBe(200)
		expect(row?.cacheControl, path).toBe('no-store')
	}
	const signedInLogin = signedIn.find((entry) => entry.path === '/login')
	expect(signedInLogin?.status).toBe(302)
	expect(
		signedIn.find((entry) => entry.path === '/guides/how-kody-works.json')
			?.cacheControl,
	).toBe(anonymousHtmlCacheControl)
	expect(
		signedIn.find((entry) => entry.path === '/onboarding.json')?.loggedInJson,
	).toBe(true)
	expect(signedIn.find((entry) => entry.path === '/')?.hasTesterUsername).toBe(
		true,
	)

	const signedInHome = signedIn.find((entry) => entry.path === '/')
	expect(
		signedInHome?.serverTiming.some((entry) => entry.name === 'session'),
	).toBe(true)
	expect(
		signedInHome?.serverTiming.some((entry) => entry.name === 'code-runs'),
	).toBe(true)

	const signedInOnboardingJson = signedIn.find(
		(entry) => entry.path === '/onboarding.json',
	)
	expect(
		signedInOnboardingJson?.serverTiming.some(
			(entry) => entry.name === 'listings',
		),
	).toBe(true)
})
