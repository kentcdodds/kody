import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createPackageCodeRequest,
	handlePackageAppRequest,
} from '#app/handlers/package-app.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
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
	// `redirect: 'manual'` keeps the entrypoint stub from following the
	// cross-origin hops this suite is asserting on.
	return await exports.default.fetch(
		new Request(url, { redirect: 'manual', ...init }),
	)
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

async function outcome(response: Response) {
	return { status: response.status, body: await response.text() }
}

test('hosted package apps move to the owner subdomain behind a single-use handoff', async () => {
	silenceExpectedConsoleWarns(['Package app handoff rejected.'])
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	const sessionCookie = await seedOwnerSessionCookie()
	const entryUrl = `${appOrigin}/@${ownerUsername}/packages/demo/report`

	// 1. The app origin never executes package code: it mints a handoff token and
	// redirects to the owner's package-app subdomain, where the username lives in
	// the hostname and the path carries only the package mount. Query preserved.
	const appOriginResponse = await workerFetch(`${entryUrl}?tab=1`, {
		headers: { Cookie: sessionCookie },
	})
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
	const setCookie = handoffResponse.headers.get('Set-Cookie') ?? ''
	const cookieAttributes = [
		'__Host-kody_pkg_session=',
		'HttpOnly',
		'SameSite=Lax',
		'Secure',
		'Path=/',
	]
	expect(cookieAttributes.filter((part) => !setCookie.includes(part))).toEqual(
		[],
	)
	expect(setCookie).not.toContain('Domain=')
	const packageSessionMaxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1])
	// Fresh non-remember-me `kody_session` is 7 days; the exchanged cookie
	// inherits that remaining time rather than a fixed 12-hour cap.
	expect(packageSessionMaxAge).toBeGreaterThan(7 * 24 * 60 * 60 - 30)
	expect(packageSessionMaxAge).toBeLessThanOrEqual(7 * 24 * 60 * 60)
	const cleanLocation = new URL(handoffResponse.headers.get('Location') ?? '')
	expect(cleanLocation.origin).toBe(ownerPackageAppOrigin)
	expect(cleanLocation.searchParams.has(packageAppHandoffQueryParam)).toBe(
		false,
	)
	expect(cleanLocation.searchParams.get('tab')).toBe('1')
	const packageSessionCookie = setCookie.split(';')[0] ?? ''
	const withPackageSession = (headers: Record<string, string> = {}) => ({
		headers: { Cookie: packageSessionCookie, ...headers },
	})

	// 3. With the package-app session, requests reach package-app serving: the
	// owner is resolved and the saved package lookup 404s (none is seeded), which
	// is distinct from the origin-level 404 below. A stale or forged token next
	// to a valid session is ignored and stripped before serving. The session is
	// bound to one account and the subdomain names the account, so the owner's
	// cookie on another user's subdomain never serves package code. Sibling
	// subdomains are same-site, so a Lax cookie would attach to their
	// cross-origin requests: a mutating request whose Origin is not this
	// subdomain is rejected before package code runs; same-origin passes.
	const staleTokenUrl = new URL(cleanLocation)
	staleTokenUrl.searchParams.set(packageAppHandoffQueryParam, `${handoffToken}`)
	const servingCases = [
		{ name: 'clean URL', url: cleanLocation },
		{ name: 'stale token', url: staleTokenUrl },
		{
			name: 'other user subdomain',
			url: 'https://other-user.packages.isolated.test/packages/demo',
		},
		{
			name: 'same-origin POST',
			url: cleanLocation,
			postFrom: ownerPackageAppOrigin,
		},
	]
	for (const { name, url, postFrom } of servingCases) {
		const response = await workerFetch(url, {
			...(postFrom ? { method: 'POST' } : {}),
			...withPackageSession(postFrom ? { Origin: postFrom } : {}),
		})
		expect({ name, ...(await outcome(response)) }).toEqual({
			name,
			status: 404,
			body: buildPackageAppNotFoundMessage(),
		})
	}
	const crossOriginPost = await workerFetch(cleanLocation, {
		method: 'POST',
		...withPackageSession({
			Origin: 'https://other-user.packages.isolated.test',
		}),
	})
	expect(crossOriginPost.status).toBe(403)
	await expect(crossOriginPost.text()).resolves.toContain(
		'Cross-origin mutating requests',
	)

	// 4. The package-app session is re-checked against the account on every
	// request, so suspension and password changes revoke package-app access too.
	const ownerStableUserId = await createStableUserIdFromEmail(ownerEmail)
	for (const [column, value] of [
		['suspended_at', new Date().toISOString()],
		['password_changed_at', new Date(Date.now() + 1000).toISOString()],
	] as const) {
		await env.APP_DB.prepare(`UPDATE users SET ${column} = ? WHERE email = ?`)
			.bind(value, ownerEmail)
			.run()
		invalidatePackageAppOwnerCache({ stableUserId: ownerStableUserId })
		const revoked = await workerFetch(cleanLocation, withPackageSession())
		expect({ column, status: revoked.status }).toEqual({ column, status: 403 })
		await env.APP_DB.prepare(
			`UPDATE users SET ${column} = NULL WHERE email = ?`,
		)
			.bind(ownerEmail)
			.run()
		invalidatePackageAppOwnerCache({ stableUserId: ownerStableUserId })
	}

	// 5. Replaying the consumed token is refused, and so is any request without a
	// package-app session. Both terminate here (never a redirect back to the app
	// origin) so a browser that drops the cookie cannot ping-pong between hosts.
	// The terminal page links to the app-origin entry path that restarts the
	// handoff. A presented-but-rejected token is not a cookie problem.
	const replayed = await workerFetch(handoffLocation)
	expect(replayed.status).toBe(403)
	expect(replayed.headers.get('Location')).toBeNull()
	expect(replayed.headers.get('X-Kody-Handoff')).toBe('rejected')
	const replayedBody = await replayed.text()
	expect(replayedBody).toContain(entryUrl)
	expect(replayedBody).toContain(
		'the package-app domain did not accept the token',
	)
	const missingSession = await workerFetch(cleanLocation)
	expect(missingSession.status).toBe(403)
	expect(missingSession.headers.get('X-Kody-Handoff')).toBe('required')
	const missingSessionBody = await missingSession.text()
	expect(missingSessionBody).toContain(entryUrl)
	expect(missingSessionBody).toContain('your browser is refusing this site')
	const rejectedJson = await workerFetch(cleanLocation, {
		headers: { Accept: 'application/json' },
	})
	expect(rejectedJson.status).toBe(403)
	await expect(rejectedJson.json()).resolves.toMatchObject({
		error: 'Package app session required',
	})

	// 6. Nothing first-party is reachable on the package-app domain (bare origin
	// or user subdomain), and hostnames that are not a valid username label fail
	// closed: wildcard DNS routes them here, but nothing serves.
	const unmatchedUrls = [
		...[packageAppOrigin, ownerPackageAppOrigin].flatMap((origin) =>
			[
				'/account/secrets.json',
				'/login',
				'/mcp',
				'/session',
				`/@${ownerUsername}/api/package-invocations/demo`,
				`/@${ownerUsername}/connectors/home/instance`,
			].map((path) => `${origin}${path}`),
		),
		'https://nested.label.packages.isolated.test/packages/demo',
		'https://Bad_Label.packages.isolated.test/packages/demo',
		'https://xy.packages.isolated.test/packages/demo',
	]
	const unmatched = buildUnmatchedPackageAppOriginPathMessage()
	for (const url of unmatchedUrls) {
		const response = await workerFetch(url, {
			headers: { Cookie: `${packageSessionCookie}; ${sessionCookie}` },
		})
		expect({ url, ...(await outcome(response)) }).toEqual({
			url,
			status: 404,
			body: unmatched,
		})
	}

	// 7. Legacy path-based URLs on the bare package-app origin redirect to the
	// owning user's subdomain (dropping any handoff token, keeping the query).
	const legacyUrl = new URL(
		`${packageAppOrigin}/@${ownerUsername}/packages/demo/report?tab=1`,
	)
	legacyUrl.searchParams.set(packageAppHandoffQueryParam, 'stale-token')
	const legacyResponse = await workerFetch(legacyUrl)
	expect(legacyResponse.status).toBe(302)
	expect(legacyResponse.headers.get('Location')).toBe(
		`${ownerPackageAppOrigin}/packages/demo/report?tab=1`,
	)

	// 8. The bare package-app origin and a bare user subdomain are plausible
	// bookmarks; send them home.
	for (const origin of [packageAppOrigin, ownerPackageAppOrigin]) {
		const rootResponse = await workerFetch(`${origin}/`)
		expect(rootResponse.status).toBe(302)
		expect(rootResponse.headers.get('Location')).toBe(`${appOrigin}/`)
	}

	// 9. The package-app session is not an app session: the app origin refuses
	// it and sends the visitor to log in.
	const appOriginWithPackageCookie = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo`,
		withPackageSession(),
	)
	expect(appOriginWithPackageCookie.status).toBe(302)
	expect(
		new URL(appOriginWithPackageCookie.headers.get('Location') ?? '').pathname,
	).toBe('/login')

	// 10. A signed-in visitor on the owner-only handoff mount is sent to the
	// saved-package page (`/@{username}/{kodyId}`), not a "not found" 404.
	const visitorOnHandoffMount = await workerFetch(
		`${appOrigin}/@other-user/packages/demo/report`,
		{ headers: { Cookie: sessionCookie } },
	)
	expect(visitorOnHandoffMount.status).toBe(302)
	expect(visitorOnHandoffMount.headers.get('Location')).toBe(
		`${appOrigin}/@other-user/demo`,
	)
})

test('package apps stay inline on the app origin when no package-app origin is configured', async () => {
	configureOrigins({ packageAppBaseUrl: undefined, runtime: 'preview' })
	invalidatePackageAppOwnerCache({
		stableUserId: await createStableUserIdFromEmail(ownerEmail),
	})
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
	expect(
		[
			'Cookie',
			'Authorization',
			'Proxy-Authorization',
			'X-Kody-Connector-Session-Key',
		].filter((name) => packageCodeRequest.headers.has(name)),
	).toEqual([])
	expect(packageCodeRequest.headers.get('Content-Type')).toBe(
		'application/json',
	)
	await expect(packageCodeRequest.json()).resolves.toEqual({ hello: 'world' })
})
