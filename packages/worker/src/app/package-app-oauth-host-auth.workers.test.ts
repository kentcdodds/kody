import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	createPackageAppSessionCookie,
	readPackageAppSession,
	resetPackageAppSessionCookieForTests,
} from '#app/package-app-session.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const packageAppOrigin = 'https://packages.isolated.test'
const ownerUsername = 'pkglogout'
const ownerPackageAppOrigin = `https://${ownerUsername}.packages.isolated.test`
const stableUserId = testStableUserIdFromEmail('pkg-logout-owner@example.com')

function configureOrigins() {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = 'https://app.kody.test:8788'
	mutableEnv.PACKAGE_APP_BASE_URL = packageAppOrigin
	mutableEnv.SENTRY_ENVIRONMENT = 'test'
}

async function workerFetch(url: string | URL, init: RequestInit = {}) {
	return await exports.default.fetch(
		new Request(url, { redirect: 'manual', ...init }),
	)
}

test('shared-host logout clears only the requesting app session', async () => {
	resetPackageAppSessionCookieForTests()
	configureOrigins()

	const expiresAt = Date.now() + 60 * 60 * 1000
	const session = { stableUserId, username: ownerUsername }
	const cookiesA = await createPackageAppSessionCookie({
		env,
		session,
		slug: 'notes',
		secure: true,
		expiresAt,
	})
	const cookiesB = await createPackageAppSessionCookie({
		env,
		session,
		slug: 'worlds',
		secure: true,
		expiresAt,
	})
	const pairA = cookiesA[0]?.split(';')[0] ?? ''
	const pairB = cookiesB[0]?.split(';')[0] ?? ''
	const cookieHeader = `${pairA}; ${pairB}`

	const logout = await workerFetch(
		`${ownerPackageAppOrigin}${packageAppOauthPaths.logout}?app=notes&return_to=${encodeURIComponent('/packages/notes')}`,
		{ headers: { Cookie: cookieHeader } },
	)
	expect(logout.status).toBe(302)
	expect(logout.headers.get('Location')).toBe('/packages/notes')
	const cleared = logout.headers.getSetCookie()
	const clearedNames = new Set(
		cleared.map((header) => header.split('=')[0]?.trim()).filter(Boolean),
	)
	expect(clearedNames.has(pairA.split('=')[0] ?? '')).toBe(true)
	expect(clearedNames.has(pairB.split('=')[0] ?? '')).toBe(false)

	const remaining = cookieHeader
		.split(';')
		.map((part) => part.trim())
		.filter((part) => {
			const name = part.split('=')[0]
			return name && !clearedNames.has(name)
		})
		.join('; ')

	await expect(
		readPackageAppSession({
			request: new Request(`${ownerPackageAppOrigin}/packages/notes`, {
				headers: { Cookie: remaining },
			}),
			env,
			slug: 'notes',
		}),
	).resolves.toBeNull()
	await expect(
		readPackageAppSession({
			request: new Request(`${ownerPackageAppOrigin}/packages/worlds`, {
				headers: { Cookie: remaining },
			}),
			env,
			slug: 'worlds',
		}),
	).resolves.toMatchObject({ session })
})

test('shared-host logout without app identity is rejected', async () => {
	configureOrigins()
	const response = await workerFetch(
		`${ownerPackageAppOrigin}${packageAppOauthPaths.logout}?return_to=/`,
	)
	expect(response.status).toBe(400)
	await expect(response.text()).resolves.toContain('Missing app identity')
})

test('shared-host logout accepts app leaf from return_to as a fallback', async () => {
	resetPackageAppSessionCookieForTests()
	configureOrigins()
	const expiresAt = Date.now() + 60 * 60 * 1000
	const cookies = await createPackageAppSessionCookie({
		env,
		session: { stableUserId, username: ownerUsername },
		slug: 'notes',
		secure: true,
		expiresAt,
	})
	const pair = cookies[0]?.split(';')[0] ?? ''
	const logout = await workerFetch(
		`${ownerPackageAppOrigin}${packageAppOauthPaths.logout}?return_to=${encodeURIComponent('/packages/notes/home')}`,
		{ headers: { Cookie: pair } },
	)
	expect(logout.status).toBe(302)
	const clearedNames = new Set(
		logout.headers
			.getSetCookie()
			.map((header) => header.split('=')[0]?.trim())
			.filter(Boolean),
	)
	expect(clearedNames.has(pair.split('=')[0] ?? '')).toBe(true)
})
