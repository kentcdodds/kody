import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { createPackageCodeRequest } from '#app/handlers/package-app.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'
import {
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

// Different ports on purpose: swapping origins by mutating a `URL` keeps the
// original port, and identical ports would hide that.
const appOrigin = 'https://app.kody.test:8788'
const packageAppOrigin = 'https://packages.kody.test'
const ownerEmail = 'pkg-owner@example.com'
const ownerUsername = 'pkg-owner'

/**
 * The generated `Env` types pin production var literals, so origin overrides go
 * through a mutable view of the same object the worker handler receives.
 */
function configureOrigins(input: { packageAppBaseUrl?: string }) {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = appOrigin
	mutableEnv.PACKAGE_APP_BASE_URL = input.packageAppBaseUrl
}

async function workerFetch(
	url: string | URL,
	init: RequestInit = {},
): Promise<Response> {
	const ctx = createExecutionContext()
	// `redirect: 'manual'` keeps the entrypoint stub from following the
	// cross-origin hops this suite is asserting on.
	const response = await exports.default.fetch(
		new Request(url, { redirect: 'manual', ...init }),
		env,
		ctx,
	)
	await waitOnExecutionContext(ctx)
	return response
}

async function seedOwnerSessionCookie() {
	await ensureRbacTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	// Session resolution joins the permission tables; without them every request
	// logs a role-lookup failure.
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
			stableUserId: await createStableUserIdFromEmail(ownerEmail),
			email: ownerEmail,
			rememberMe: false,
		},
		true,
	)
	return setCookie.split(';')[0] ?? ''
}

function cookieValue(setCookieHeader: string) {
	return setCookieHeader.split(';')[0] ?? ''
}

test('hosted package apps move to the package-app origin behind a single-use handoff', async () => {
	configureOrigins({ packageAppBaseUrl: packageAppOrigin })
	const sessionCookie = await seedOwnerSessionCookie()

	// 1. The app origin never executes package code: it mints a handoff token and
	// redirects to the package-app origin, preserving path and query.
	const appOriginResponse = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo/report?tab=1`,
		{ headers: { Cookie: sessionCookie } },
	)
	expect(appOriginResponse.status).toBe(302)
	const handoffLocation = new URL(
		appOriginResponse.headers.get('Location') ?? '',
	)
	expect(handoffLocation.origin).toBe(packageAppOrigin)
	expect(handoffLocation.pathname).toBe(
		`/@${ownerUsername}/packages/demo/report`,
	)
	expect(handoffLocation.searchParams.get('tab')).toBe('1')
	const handoffToken = handoffLocation.searchParams.get(
		packageAppHandoffQueryParam,
	)
	expect(handoffToken).toBeTruthy()

	// 2. The package-app origin exchanges the token for its own host-scoped
	// cookie, then bounces to the clean URL so the token stops travelling.
	const handoffResponse = await workerFetch(handoffLocation)
	expect(handoffResponse.status).toBe(302)
	const packageSessionCookieHeader =
		handoffResponse.headers.get('Set-Cookie') ?? ''
	expect(packageSessionCookieHeader).toContain('kody_pkg_session=')
	expect(packageSessionCookieHeader).toContain('HttpOnly')
	expect(packageSessionCookieHeader).toContain('SameSite=Lax')
	expect(packageSessionCookieHeader).toContain('Secure')
	const cleanLocation = new URL(handoffResponse.headers.get('Location') ?? '')
	expect(cleanLocation.origin).toBe(packageAppOrigin)
	expect(cleanLocation.searchParams.has(packageAppHandoffQueryParam)).toBe(
		false,
	)
	expect(cleanLocation.searchParams.get('tab')).toBe('1')
	const packageSessionCookie = cookieValue(packageSessionCookieHeader)

	// 3. With the package-app session, the request reaches package-app serving:
	// the owner is resolved and the saved package lookup 404s (none is seeded),
	// which is distinct from the origin-level 404 below.
	const servedResponse = await workerFetch(cleanLocation, {
		headers: { Cookie: packageSessionCookie },
	})
	expect(servedResponse.status).toBe(404)
	await expect(servedResponse.text()).resolves.toBe(
		'Saved package app not found.',
	)

	// 4. A stale or forged token alongside a valid session is ignored rather than
	// rejected, and never reaches package code (the request is rewritten without
	// it before serving).
	const staleTokenUrl = new URL(cleanLocation)
	staleTokenUrl.searchParams.set(packageAppHandoffQueryParam, `${handoffToken}`)
	const staleTokenResponse = await workerFetch(staleTokenUrl, {
		headers: { Cookie: packageSessionCookie },
	})
	expect(staleTokenResponse.status).toBe(404)
	await expect(staleTokenResponse.text()).resolves.toBe(
		'Saved package app not found.',
	)

	// 5. The package-app session is re-checked against the account on every
	// request, so suspension and password changes revoke package-app access too.
	for (const [column, value] of [
		['suspended_at', new Date().toISOString()],
		['password_changed_at', new Date(Date.now() + 1000).toISOString()],
	] as const) {
		await env.APP_DB.prepare(`UPDATE users SET ${column} = ? WHERE email = ?`)
			.bind(value, ownerEmail)
			.run()
		const revoked = await workerFetch(cleanLocation, {
			headers: { Cookie: packageSessionCookie },
		})
		expect(revoked.status, `expected ${column} to revoke access`).toBe(403)
		await env.APP_DB.prepare(
			`UPDATE users SET ${column} = NULL WHERE email = ?`,
		)
			.bind(ownerEmail)
			.run()
	}

	// 6. Replaying the consumed token is refused, and so is any request without a
	// package-app session. Both terminate here (never a redirect back to the app
	// origin) so a browser that drops the cookie cannot ping-pong between hosts.
	for (const request of [handoffLocation, cleanLocation]) {
		const rejected = await workerFetch(request)
		expect(rejected.status).toBe(403)
		expect(rejected.headers.get('Location')).toBeNull()
		await expect(rejected.text()).resolves.toContain(
			`${appOrigin}/@${ownerUsername}/packages/demo/report`,
		)
	}
	const rejectedJson = await workerFetch(cleanLocation, {
		headers: { Accept: 'application/json' },
	})
	expect(rejectedJson.status).toBe(403)
	await expect(rejectedJson.json()).resolves.toMatchObject({
		error: 'Package app session required',
	})

	// 7. Nothing first-party is reachable on the package-app origin.
	for (const path of [
		'/account/secrets.json',
		'/login',
		'/mcp',
		'/session',
		`/@${ownerUsername}/api/package-invocations/demo`,
		`/@${ownerUsername}/connectors/home/instance`,
	]) {
		const response = await workerFetch(`${packageAppOrigin}${path}`, {
			headers: { Cookie: `${packageSessionCookie}; ${sessionCookie}` },
		})
		expect(response.status, `expected 404 for ${path}`).toBe(404)
		await expect(response.text()).resolves.toBe('Not Found')
	}

	// 8. The bare package-app origin is a plausible bookmark; send it home.
	const rootResponse = await workerFetch(`${packageAppOrigin}/`)
	expect(rootResponse.status).toBe(302)
	expect(rootResponse.headers.get('Location')).toBe(`${appOrigin}/`)

	// 9. The package-app session is not an app session: the app origin refuses it
	// and sends the visitor to log in.
	const appOriginWithPackageCookie = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo`,
		{ headers: { Cookie: packageSessionCookie } },
	)
	expect(appOriginWithPackageCookie.status).toBe(302)
	expect(
		new URL(appOriginWithPackageCookie.headers.get('Location') ?? '').pathname,
	).toBe('/login')
})

test('package apps stay inline on the app origin when no package-app origin is configured', async () => {
	configureOrigins({ packageAppBaseUrl: undefined })
	const sessionCookie = await seedOwnerSessionCookie()

	const response = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo`,
		{ headers: { Cookie: sessionCookie } },
	)
	// Served inline (no cross-origin redirect); the saved package does not exist.
	expect(response.status).toBe(404)
	await expect(response.text()).resolves.toBe('Saved package app not found.')
})

test('createPackageCodeRequest drops credential headers in the workers runtime', async () => {
	const packageCodeRequest = createPackageCodeRequest(
		new Request(`${packageAppOrigin}/@${ownerUsername}/packages/demo/save`, {
			method: 'POST',
			headers: {
				Cookie: 'kody_session=owner; kody_pkg_session=package',
				Authorization: 'Bearer owner-token',
				'Proxy-Authorization': 'Basic owner',
				'X-Kody-Connector-Session-Key': 'internal',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ hello: 'world' }),
		}),
		new URL(`${packageAppOrigin}/save`),
	)

	expect(packageCodeRequest.url).toBe(`${packageAppOrigin}/save`)
	expect(packageCodeRequest.headers.get('Cookie')).toBeNull()
	expect(packageCodeRequest.headers.get('Authorization')).toBeNull()
	expect(packageCodeRequest.headers.get('Proxy-Authorization')).toBeNull()
	expect(
		packageCodeRequest.headers.get('X-Kody-Connector-Session-Key'),
	).toBeNull()
	expect(packageCodeRequest.headers.get('Content-Type')).toBe(
		'application/json',
	)
	await expect(packageCodeRequest.json()).resolves.toEqual({ hello: 'world' })
})
