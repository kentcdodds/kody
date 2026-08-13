import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createPackageCodeRequest,
	handlePackageAppRequest,
} from '#app/handlers/package-app.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'
import {
	buildPackageAppNotFoundMessage,
	buildUnmatchedPackageAppOriginPathMessage,
} from '#worker/package-runtime/package-app-synthetic.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import {
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

// Different ports on purpose: swapping origins by mutating a `URL` keeps the
// original port, and identical ports would hide that.
const appOrigin = 'https://app.kody.test:8788'
const packageAppOrigin = 'https://packages.isolated.test'
const ownerEmail = 'pkg-owner@example.com'
const ownerUsername = 'pkg-owner'
// Hosted package apps are served from the owner's own subdomain of the
// package-app origin; the bare origin only redirects.
const ownerPackageAppOrigin = `https://${ownerUsername}.packages.isolated.test`

/**
 * The generated `Env` types pin production var literals, so origin overrides go
 * through a mutable view of the same object the worker handler receives.
 */
function configureOrigins(input: {
	packageAppBaseUrl?: string
	runtime: 'production' | 'preview'
}) {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = appOrigin
	mutableEnv.PACKAGE_APP_BASE_URL = input.packageAppBaseUrl
	mutableEnv.SENTRY_ENVIRONMENT = input.runtime
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

test('hosted package apps move to the owner subdomain behind a single-use handoff', async () => {
	silenceExpectedConsoleWarns(['Package app handoff rejected.'])
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	const sessionCookie = await seedOwnerSessionCookie()

	// 1. The app origin never executes package code: it mints a handoff token and
	// redirects to the owner's package-app subdomain, where the username lives in
	// the hostname and the path carries only the package mount. Query preserved.
	const appOriginResponse = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo/report?tab=1`,
		{ headers: { Cookie: sessionCookie } },
	)
	expect(appOriginResponse.status).toBe(302)
	const handoffLocation = new URL(
		appOriginResponse.headers.get('Location') ?? '',
	)
	expect(handoffLocation.origin).toBe(ownerPackageAppOrigin)
	expect(handoffLocation.pathname).toBe('/packages/demo/report')
	expect(handoffLocation.searchParams.get('tab')).toBe('1')
	const handoffToken = handoffLocation.searchParams.get(
		packageAppHandoffQueryParam,
	)
	expect(handoffToken).toBeTruthy()

	// 2. The owner subdomain exchanges the token for its own host-scoped cookie,
	// then bounces to the clean URL so the token stops travelling. The secure
	// cookie uses the `__Host-` prefix, so browsers refuse any variant carrying a
	// `Domain` attribute (cookie tossing from sibling subdomains).
	const handoffResponse = await workerFetch(handoffLocation)
	expect(handoffResponse.status).toBe(302)
	const packageSessionCookieHeader =
		handoffResponse.headers.get('Set-Cookie') ?? ''
	expect(packageSessionCookieHeader).toContain('__Host-kody_pkg_session=')
	expect(packageSessionCookieHeader).toContain('HttpOnly')
	expect(packageSessionCookieHeader).toContain('SameSite=Lax')
	expect(packageSessionCookieHeader).toContain('Secure')
	expect(packageSessionCookieHeader).toContain('Path=/')
	expect(packageSessionCookieHeader).not.toContain('Domain=')
	const cleanLocation = new URL(handoffResponse.headers.get('Location') ?? '')
	expect(cleanLocation.origin).toBe(ownerPackageAppOrigin)
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
		buildPackageAppNotFoundMessage(),
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
		buildPackageAppNotFoundMessage(),
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
	// The terminal page links to the app-origin entry path that restarts the
	// handoff. A presented-but-rejected token is not a cookie problem.
	const replayed = await workerFetch(handoffLocation)
	expect(replayed.status).toBe(403)
	expect(replayed.headers.get('Location')).toBeNull()
	expect(replayed.headers.get('X-Kody-Handoff')).toBe('rejected')
	const replayedBody = await replayed.text()
	expect(replayedBody).toContain(
		`${appOrigin}/@${ownerUsername}/packages/demo/report`,
	)
	expect(replayedBody).toContain(
		'the package-app domain did not accept the token',
	)
	const missingSession = await workerFetch(cleanLocation)
	expect(missingSession.status).toBe(403)
	expect(missingSession.headers.get('X-Kody-Handoff')).toBe('required')
	const missingSessionBody = await missingSession.text()
	expect(missingSessionBody).toContain(
		`${appOrigin}/@${ownerUsername}/packages/demo/report`,
	)
	expect(missingSessionBody).toContain('your browser is refusing this site')
	const rejectedJson = await workerFetch(cleanLocation, {
		headers: { Accept: 'application/json' },
	})
	expect(rejectedJson.status).toBe(403)
	await expect(rejectedJson.json()).resolves.toMatchObject({
		error: 'Package app session required',
	})

	// 7. The session is bound to one account and the subdomain names the account:
	// the owner's cookie on another user's subdomain never serves package code.
	const crossUserResponse = await workerFetch(
		'https://other-user.packages.isolated.test/packages/demo',
		{ headers: { Cookie: packageSessionCookie } },
	)
	expect(crossUserResponse.status).toBe(404)
	await expect(crossUserResponse.text()).resolves.toBe(
		buildPackageAppNotFoundMessage(),
	)

	// 7b. Sibling subdomains are same-site, so a Lax cookie would attach to
	// their cross-origin requests. A mutating request whose Origin is not this
	// subdomain is rejected before any package code runs, even with a valid
	// session; a same-origin mutation passes through to serving.
	const crossOriginPost = await workerFetch(cleanLocation, {
		method: 'POST',
		headers: {
			Cookie: packageSessionCookie,
			Origin: 'https://other-user.packages.isolated.test',
		},
	})
	expect(crossOriginPost.status).toBe(403)
	await expect(crossOriginPost.text()).resolves.toContain(
		'Cross-origin mutating requests',
	)
	const sameOriginPost = await workerFetch(cleanLocation, {
		method: 'POST',
		headers: {
			Cookie: packageSessionCookie,
			Origin: ownerPackageAppOrigin,
		},
	})
	expect(sameOriginPost.status).toBe(404)
	await expect(sameOriginPost.text()).resolves.toBe(
		buildPackageAppNotFoundMessage(),
	)

	// 8. Nothing first-party is reachable on the package-app domain — neither on
	// the bare origin nor on a user subdomain.
	for (const origin of [packageAppOrigin, ownerPackageAppOrigin]) {
		for (const path of [
			'/account/secrets.json',
			'/login',
			'/mcp',
			'/session',
			`/@${ownerUsername}/api/package-invocations/demo`,
			`/@${ownerUsername}/connectors/home/instance`,
		]) {
			const response = await workerFetch(`${origin}${path}`, {
				headers: { Cookie: `${packageSessionCookie}; ${sessionCookie}` },
			})
			expect(response.status, `expected 404 for ${origin}${path}`).toBe(404)
			const body = await response.text()
			expect(body).toBe(buildUnmatchedPackageAppOriginPathMessage())
		}
	}

	// 9. Hostnames under the package-app domain that are not a valid username
	// label fail closed: wildcard DNS routes them here, but nothing serves.
	for (const badHost of [
		'https://nested.label.packages.isolated.test',
		'https://Bad_Label.packages.isolated.test',
		'https://xy.packages.isolated.test',
	]) {
		const response = await workerFetch(`${badHost}/packages/demo`, {
			headers: { Cookie: packageSessionCookie },
		})
		expect(response.status, `expected 404 for ${badHost}`).toBe(404)
		await expect(response.text()).resolves.toBe(
			buildUnmatchedPackageAppOriginPathMessage(),
		)
	}

	// 10. Legacy path-based URLs on the bare package-app origin redirect to the
	// owning user's subdomain (dropping any handoff token, keeping the query).
	const legacyUrl = new URL(
		`${packageAppOrigin}/@${ownerUsername}/packages/demo/report?tab=1`,
	)
	legacyUrl.searchParams.set(packageAppHandoffQueryParam, 'stale-token')
	const legacyResponse = await workerFetch(legacyUrl)
	expect(legacyResponse.status).toBe(302)
	const legacyLocation = new URL(legacyResponse.headers.get('Location') ?? '')
	expect(legacyLocation.origin).toBe(ownerPackageAppOrigin)
	expect(legacyLocation.pathname).toBe('/packages/demo/report')
	expect(legacyLocation.searchParams.get('tab')).toBe('1')
	expect(legacyLocation.searchParams.has(packageAppHandoffQueryParam)).toBe(
		false,
	)

	// 11. The bare package-app origin and a bare user subdomain are plausible
	// bookmarks; send them home.
	for (const origin of [packageAppOrigin, ownerPackageAppOrigin]) {
		const rootResponse = await workerFetch(`${origin}/`)
		expect(rootResponse.status).toBe(302)
		expect(rootResponse.headers.get('Location')).toBe(`${appOrigin}/`)
	}

	// 12. The package-app session is not an app session: the app origin refuses
	// it and sends the visitor to log in.
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
	configureOrigins({ packageAppBaseUrl: undefined, runtime: 'preview' })
	const sessionCookie = await seedOwnerSessionCookie()

	const response = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo`,
		{ headers: { Cookie: sessionCookie } },
	)
	// Served inline (no cross-origin redirect); the saved package does not exist.
	expect(response.status).toBe(404)
	await expect(response.text()).resolves.toBe(buildPackageAppNotFoundMessage())
})

test('production package apps fail closed when origin isolation is missing or unsafe', async () => {
	for (const packageAppBaseUrl of [
		undefined,
		appOrigin,
		'https://packages.kody.test',
	]) {
		configureOrigins({ packageAppBaseUrl, runtime: 'production' })
		const response = await workerFetch(
			`${appOrigin}/@${ownerUsername}/packages/demo`,
		)

		expect(response.status).toBe(500)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(response.headers.get('Location')).toBeNull()
		await expect(response.text()).resolves.toContain(
			'Hosted package apps are unavailable.',
		)
	}

	// Defense in depth: even a future routing regression cannot call the inline
	// handler in production when the separate origin itself is configured safely.
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	const inlineResponse = await handlePackageAppRequest(
		new Request(`${appOrigin}/@${ownerUsername}/packages/demo`),
		env,
	)
	expect(inlineResponse.status).toBe(500)
	await expect(inlineResponse.text()).resolves.toContain(
		'Inline package-app serving is disabled in production.',
	)
})

test('createPackageCodeRequest drops credential headers in the workers runtime', async () => {
	const packageCodeRequest = createPackageCodeRequest(
		new Request(`${ownerPackageAppOrigin}/packages/demo/save`, {
			method: 'POST',
			headers: {
				Cookie: 'kody_session=owner; __Host-kody_pkg_session=package',
				Authorization: 'Bearer owner-token',
				'Proxy-Authorization': 'Basic owner',
				'X-Kody-Connector-Session-Key': 'internal',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ hello: 'world' }),
		}),
		new URL(`${ownerPackageAppOrigin}/save`),
	)

	expect(packageCodeRequest.url).toBe(`${ownerPackageAppOrigin}/save`)
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
