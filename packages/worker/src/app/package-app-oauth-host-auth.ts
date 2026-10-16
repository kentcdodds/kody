import { isSecureRequest } from '#app/auth-session.ts'
import {
	getAppBaseUrl,
	getPackageAppBaseUrl,
	parsePackageAppRequestHost,
} from '#worker/app-base-url.ts'
import { consumePackageAppOauthCode } from '#app/package-app-oauth-codes.ts'
import { formatPackageAppOauthClientId } from '#app/package-app-oauth-client-id.ts'
import { resolvePackageAppOauthClient } from '#app/package-app-oauth-client-resolve.ts'
import { findLivePackageAppOauthGrant } from '#app/package-app-oauth-grants.ts'
import {
	createPackageAppOauthCodeVerifier,
	createPackageAppOauthPkceCookie,
	createPackageAppOauthState,
	createS256CodeChallenge,
	destroyPackageAppOauthPkceCookie,
	readPackageAppOauthPkceState,
} from '#app/package-app-oauth-pkce-cookie.ts'
import {
	parsePackageAppOauthScopes,
	scopesIncludeEmail,
} from '#app/package-app-oauth-scopes.ts'
import {
	createPackageAppSessionCookie,
	destroyPackageAppSessionCookie,
	readPackageAppSession,
} from '#app/package-app-session.ts'
import {
	destroyPackageAppTicketCookie,
	readPackageAppTicket,
} from '#app/package-app-ticket.ts'
import {
	resolvePackageAppOrgOwnerByHandle,
	resolvePackageAppOwnerByStableUserId,
} from '#app/package-app-owner.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { viewerCanExecutePackageApp } from '#app/package-viewer-access.ts'
import { resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import {
	isVerifiedAppCustomHostname,
	isVerifiedOrgCustomHostname,
	normalizeCustomHostname,
} from '#worker/package-app-custom-hostnames/lookup.ts'
import { lookupCachedPackageAppCustomHostname } from '#worker/package-app-custom-hostnames/lookup-cache.ts'
import { isPackageAppCustomDomainsEnabled } from '#worker/package-app-custom-hostnames/feature-flag.ts'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import { resolveDisplayName } from '#worker/identity/username.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { resolvePackageAppOauthInlineIdentity } from '#app/package-app-oauth-inline-identity.ts'

/**
 * Host-root `/_kody/auth/*` routes on package-app origins and verified custom
 * domains (and on the app origin when `PACKAGE_APP_BASE_URL` is unset for
 * preview / path-based inline serving). Starts PKCE, exchanges the
 * authorization code for a per-app host-only package-app session cookie, clears
 * only that app's session on logout (shared hosts keep sibling app sessions),
 * and exposes `/me`.
 */

function redirectResponse(location: string, setCookies: Array<string> = []) {
	const headers = new Headers({
		Location: location,
		'Cache-Control': 'no-store',
	})
	for (const cookie of setCookies) headers.append('Set-Cookie', cookie)
	return new Response(null, { status: 302, headers })
}

function badRequest(message: string, status = 400) {
	return new Response(message, {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function normalizeReturnTo(raw: string | null, origin: string): string {
	if (!raw) return '/'
	try {
		if (raw.startsWith('/')) {
			if (raw.startsWith('//') || raw.includes('\\')) return '/'
			return raw
		}
		const url = new URL(raw)
		if (url.origin !== origin) return '/'
		return `${url.pathname}${url.search}`
	} catch {
		return '/'
	}
}

function readAppSlugParam(url: URL) {
	const raw = (
		url.searchParams.get('app') ??
		url.searchParams.get('package') ??
		url.searchParams.get('kody_id')
	)?.trim()
	return raw ? raw.toLowerCase() : undefined
}

/** Best-effort leaf from a host-root `return_to` like `/packages/{leaf}/…`. */
function readAppSlugFromReturnTo(returnTo: string) {
	const match = /^\/packages\/([^/?#]+)/i.exec(returnTo)
	const raw = match?.[1]?.trim()
	return raw ? raw.toLowerCase() : undefined
}

async function resolveVerifiedHostApp(input: {
	env: Env
	orgUsername: string
	kodyId: string
}): Promise<{ orgUsername: string; kodyId: string } | null> {
	// Never trust a raw subdomain label or query param as the OAuth owner —
	// the package must exist and be served under that handle.
	const resolved = await resolvePackageAppOauthClient({
		env: input.env,
		username: input.orgUsername,
		kodyId: input.kodyId,
	})
	if (!resolved) return null
	return {
		orgUsername: resolved.client.username,
		kodyId: resolved.client.kodyId,
	}
}

async function resolveHostApp(input: {
	request: Request
	env: Env
	url: URL
}): Promise<{ orgUsername: string; kodyId: string } | null> {
	const requestHost = parsePackageAppRequestHost({
		env: input.env,
		url: input.url,
	})
	if (requestHost?.kind === 'user-subdomain') {
		const app = readAppSlugParam(input.url)
		if (!app) return null
		return await resolveVerifiedHostApp({
			env: input.env,
			orgUsername: requestHost.username,
			kodyId: app,
		})
	}

	const hostname = normalizeCustomHostname(input.url.hostname)
	if (hostname && (await isPackageAppCustomDomainsEnabled(input.env.APP_DB))) {
		const mapping = await lookupCachedPackageAppCustomHostname({
			db: input.env.APP_DB,
			hostname,
		})
		if (mapping) {
			if (isVerifiedAppCustomHostname(mapping)) {
				return await resolveVerifiedHostApp({
					env: input.env,
					orgUsername: mapping.username,
					kodyId: mapping.kodyId.toLowerCase(),
				})
			}
			if (isVerifiedOrgCustomHostname(mapping)) {
				const app = readAppSlugParam(input.url)
				if (!app) return null
				return await resolveVerifiedHostApp({
					env: input.env,
					orgUsername: mapping.username,
					kodyId: app,
				})
			}
		}
	}

	// Preview / path-based inline serving: no package-app origin, so resolve
	// from query params or return_to on the app origin itself.
	if (!getPackageAppBaseUrl({ env: input.env })) {
		const inline = resolvePackageAppOauthInlineIdentity(input.url)
		if (!inline) return null
		return await resolveVerifiedHostApp({
			env: input.env,
			orgUsername: inline.orgUsername,
			kodyId: inline.kodyId,
		})
	}
	return null
}

async function handleLogin(input: { request: Request; env: Env; url: URL }) {
	const app = await resolveHostApp(input)
	if (!app) {
		return badRequest(
			'Unknown or unpublished package app for this host. On *.kody.run pass ?app={leaf} for a published package under this owner.',
		)
	}
	const { scopes, error: scopeError } = parsePackageAppOauthScopes(
		input.url.searchParams.get('scope'),
	)
	if (scopeError) return badRequest(scopeError)

	const secure = isSecureRequest(input.request)
	const verifier = createPackageAppOauthCodeVerifier()
	const state = createPackageAppOauthState()
	const returnTo = normalizeReturnTo(
		input.url.searchParams.get('return_to'),
		input.url.origin,
	)
	const clientId = formatPackageAppOauthClientId({
		username: app.orgUsername,
		kodyId: app.kodyId,
	})
	const redirectUri = `${input.url.origin}${packageAppOauthPaths.callback}`
	const challenge = await createS256CodeChallenge(verifier)
	const authorize = new URL(
		packageAppOauthPaths.authorize,
		getAppBaseUrl({ env: input.env }),
	)
	authorize.searchParams.set('response_type', 'code')
	authorize.searchParams.set('client_id', clientId)
	authorize.searchParams.set('redirect_uri', redirectUri)
	authorize.searchParams.set('state', state)
	authorize.searchParams.set('code_challenge', challenge)
	authorize.searchParams.set('code_challenge_method', 'S256')
	authorize.searchParams.set('scope', scopes.join(' '))

	const pkceCookie = await createPackageAppOauthPkceCookie({
		env: input.env,
		secure,
		state: {
			v: 1,
			verifier,
			state,
			returnTo,
			orgUsername: app.orgUsername,
			kodyId: app.kodyId,
			scopes,
			clientId,
		},
	})
	return redirectResponse(authorize.toString(), [pkceCookie])
}

async function handleCallback(input: { request: Request; env: Env; url: URL }) {
	const code = input.url.searchParams.get('code')
	const state = input.url.searchParams.get('state')
	const oauthError = input.url.searchParams.get('error')
	const secure = isSecureRequest(input.request)
	const pkce = await readPackageAppOauthPkceState({
		request: input.request,
		env: input.env,
	})
	if (!pkce) {
		return badRequest('Missing sign-in state. Start again from the app.')
	}
	// Only clear the PKCE cookie when `state` matches — an unauthenticated
	// `?error=` navigation must not cancel a different pending sign-in.
	if (!state || state !== pkce.state) {
		return badRequest('Sign-in state mismatch. Start again from the app.')
	}
	const clearPkce = await destroyPackageAppOauthPkceCookie({
		env: input.env,
		secure,
	})

	if (oauthError) {
		return redirectResponse(
			normalizeReturnTo(pkce.returnTo, input.url.origin),
			[clearPkce],
		)
	}
	if (!code) {
		return badRequest('Missing authorization code.', 400)
	}

	const redirectUri = `${input.url.origin}${packageAppOauthPaths.callback}`
	const record = await consumePackageAppOauthCode({
		env: input.env,
		code,
		redirectUri,
		codeVerifier: pkce.verifier,
	})
	if (!record) {
		return badRequest('Authorization code was invalid or already used.', 403)
	}
	if (
		record.orgUsername !== pkce.orgUsername ||
		record.kodyId !== pkce.kodyId
	) {
		return badRequest('Authorization code was issued for a different app.', 403)
	}

	const sessionCookies = await createPackageAppSessionCookie({
		env: input.env,
		session: {
			stableUserId: record.personId,
			username: record.orgUsername,
		},
		slug: record.kodyId,
		secure,
		expiresAt: record.sessionExpiresAt,
	})
	return redirectResponse(normalizeReturnTo(pkce.returnTo, input.url.origin), [
		clearPkce,
		...sessionCookies,
	])
}

async function handleLogout(input: { request: Request; env: Env; url: URL }) {
	const secure = isSecureRequest(input.request)
	const returnTo = normalizeReturnTo(
		input.url.searchParams.get('return_to'),
		input.url.origin,
	)
	// Resolve the app that requested logout so shared hosts
	// (`{user}.kody.run/packages/{leaf}`) only clear that leaf's session.
	// Custom domains resolve from the verified hostname mapping. Older kit
	// clients omitted `?app=` on logout; fall back to `/packages/{leaf}` in
	// `return_to` when present.
	const app = await resolveHostApp(input)
	const kodyId =
		app?.kodyId ??
		readAppSlugParam(input.url) ??
		readAppSlugFromReturnTo(returnTo)
	if (!kodyId) {
		return badRequest(
			'Missing app identity for sign-out. On *.kody.run pass ?app={leaf}.',
		)
	}
	const cookies = [
		...(await destroyPackageAppSessionCookie({
			env: input.env,
			slug: kodyId,
			secure,
		})),
		await destroyPackageAppOauthPkceCookie({ env: input.env, secure }),
		await destroyPackageAppTicketCookie({
			env: input.env,
			slug: kodyId,
			secure,
		}),
	]
	return redirectResponse(returnTo, cookies)
}

async function readAvatarKeyForPerson(input: {
	env: Env
	stableUserId: string
}) {
	const row = await input.env.APP_DB.prepare(
		`SELECT avatar_key FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(input.stableUserId)
		.first<{ avatar_key: string | null }>()
	return row?.avatar_key ?? null
}

async function handleMe(input: { request: Request; env: Env; url: URL }) {
	const app = await resolveHostApp(input)
	const slug = app?.kodyId ?? readAppSlugParam(input.url)
	if (!slug) {
		return Response.json(
			{ error: 'missing_app', message: 'Pass ?app={leaf} on this host.' },
			{ status: 400, headers: { 'Cache-Control': 'no-store' } },
		)
	}

	const parsedSession = await readPackageAppSession({
		request: input.request,
		env: input.env,
		slug,
	})
	if (!parsedSession) {
		return Response.json(
			{ error: 'unauthorized' },
			{ status: 401, headers: { 'Cache-Control': 'no-store' } },
		)
	}

	const person = await resolvePackageAppOwnerByStableUserId({
		env: input.env,
		stableUserId: parsedSession.session.stableUserId,
		issuedAt: parsedSession.issuedAt,
	})
	if (!person) {
		return Response.json(
			{ error: 'unauthorized' },
			{ status: 401, headers: { 'Cache-Control': 'no-store' } },
		)
	}

	const handle = (
		app?.orgUsername ?? parsedSession.session.username
	).toLowerCase()

	const grant = await findLivePackageAppOauthGrant({
		db: input.env.APP_DB,
		personId: parsedSession.session.stableUserId,
		orgUsername: handle,
		kodyId: slug,
	})

	let role: string | null = null
	const ticket = await readPackageAppTicket({
		request: input.request,
		env: input.env,
		host: input.url.host,
		slug,
		session: {
			stableUserId: parsedSession.session.stableUserId,
			issuedAt: parsedSession.issuedAt,
		},
		secure: isSecureRequest(input.request),
	})
	if (ticket) {
		role = ticket.visitor.role
	} else if (!grant) {
		// No ticket and no OAuth grant: only package executors (owners /
		// collaborators with app:execute) may read /me.
		const org = await resolvePackageAppOrgOwnerByHandle({
			env: input.env,
			handle,
		})
		if (!org) {
			return Response.json(
				{ error: 'forbidden' },
				{ status: 403, headers: { 'Cache-Control': 'no-store' } },
			)
		}
		const lookup = await resolveSavedPackageForPackageAppSlug({
			db: input.env.APP_DB,
			userId: org.userId,
			slug,
		})
		const canExecute = await viewerCanExecutePackageApp({
			env: input.env,
			viewer: {
				userId: personIdFromStored(parsedSession.session.stableUserId),
				username: person.username,
			},
			ownerId: org.userId,
			appId: lookup?.savedPackage.id ?? null,
		})
		if (!canExecute) {
			return Response.json(
				{ error: 'forbidden' },
				{ status: 403, headers: { 'Cache-Control': 'no-store' } },
			)
		}
	}

	const avatarKey = await readAvatarKeyForPerson({
		env: input.env,
		stableUserId: parsedSession.session.stableUserId,
	})
	const relativeAvatar = buildUserAvatarUrl({
		username: person.username,
		avatarKey,
	})
	const avatarUrl = relativeAvatar
		? new URL(relativeAvatar, getAppBaseUrl({ env: input.env })).toString()
		: undefined

	let emailClaim: string | undefined
	if (grant && scopesIncludeEmail(grant.scopes)) {
		emailClaim = person.email
	}

	return Response.json(
		{
			userId: parsedSession.session.stableUserId,
			username: person.username,
			displayName: resolveDisplayName({
				email: person.email,
				username: person.username,
			}),
			...(avatarUrl ? { avatarUrl } : {}),
			...(emailClaim ? { email: emailClaim } : {}),
			role,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

/**
 * Dispatch `/_kody/auth/*` on a package-app host. Returns null when the path
 * is not an auth route so the caller can continue serving the package.
 */
export async function handlePackageAppOauthHostAuth(input: {
	request: Request
	env: Env
	url: URL
}): Promise<Response | null> {
	const { pathname } = input.url
	if (!pathname.startsWith('/_kody/auth')) return null

	if (pathname === packageAppOauthPaths.login) {
		if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
			return badRequest('Method not allowed.', 405)
		}
		return await handleLogin(input)
	}
	if (pathname === packageAppOauthPaths.callback) {
		if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
			return badRequest('Method not allowed.', 405)
		}
		return await handleCallback(input)
	}
	if (pathname === packageAppOauthPaths.logout) {
		if (
			input.request.method !== 'GET' &&
			input.request.method !== 'HEAD' &&
			input.request.method !== 'POST'
		) {
			return badRequest('Method not allowed.', 405)
		}
		return await handleLogout(input)
	}
	if (pathname === packageAppOauthPaths.me) {
		if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
			return badRequest('Method not allowed.', 405)
		}
		return await handleMe(input)
	}
	return badRequest('Unknown auth path.', 404)
}

/** True when a package-app origin request targets `/_kody/auth/*`. */
export function isPackageAppOauthHostAuthPath(pathname: string) {
	return pathname === '/_kody/auth' || pathname.startsWith('/_kody/auth/')
}
