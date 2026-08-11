import { createCookie } from '@remix-run/cookie'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { isStableUserId } from '#worker/user-id.ts'

/**
 * Host-scoped session for one user's package-app subdomain.
 *
 * This cookie is deliberately *not* `kody_session`:
 *
 * - a different name, so the app origin's session parser never sees it;
 * - a different signing secret (derived from `COOKIE_SECRET` with a purpose
 *   label), so a value signed for this cookie can never verify as an app
 *   session even if it were replayed under the other name;
 * - a different payload shape, so it cannot satisfy the app session schema.
 *
 * On secure requests the cookie is named with the `__Host-` prefix, which
 * browsers only accept when it is `Secure`, has no `Domain` attribute, and
 * has `Path=/`. That makes the cookie provably host-only: a package app on a
 * sibling subdomain cannot plant a `Domain=.<package-app domain>` cookie under
 * this name (cookie tossing), even before the package-app domain is on the
 * Public Suffix List. Plain-HTTP local development falls back to an
 * unprefixed name because browsers refuse `__Host-` cookies on insecure
 * origins.
 *
 * It authorizes hosted package-app access for one user on that user's
 * package-app subdomain and nothing else; serving additionally requires the
 * session's username to match the subdomain being requested.
 */

const securePackageAppSessionCookieName = '__Host-kody_pkg_session'
const insecurePackageAppSessionCookieName = 'kody_pkg_session'
const packageAppSessionMaxAgeSeconds = 60 * 60 * 12
const packageAppSessionSecretPurpose = 'kody-package-app-session:v2'

export type PackageAppSession = {
	stableUserId: string
	username: string
}

type StoredPackageAppSession = {
	v: 2
	stableUserId: string
	pkgUsername: string
	issuedAt: number
}

export type ParsedPackageAppSession = {
	session: PackageAppSession
	issuedAt: number
}

let cachedCookies: {
	sourceSecret: string
	secureCookie: ReturnType<typeof createCookie>
	insecureCookie: ReturnType<typeof createCookie>
} | null = null

async function getPackageAppSessionCookies(env: Env) {
	const secret = env.COOKIE_SECRET?.trim()
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for package app session signing.')
	}
	if (cachedCookies?.sourceSecret === secret) return cachedCookies

	const derivedSecret = await sha256Base64Url(
		`${packageAppSessionSecretPurpose}:${secret}`,
	)
	const sharedOptions = {
		httpOnly: true,
		sameSite: 'Lax' as const,
		path: '/',
		maxAge: packageAppSessionMaxAgeSeconds,
		secrets: [derivedSecret],
	}
	cachedCookies = {
		sourceSecret: secret,
		secureCookie: createCookie(securePackageAppSessionCookieName, {
			...sharedOptions,
			secure: true,
		}),
		insecureCookie: createCookie(insecurePackageAppSessionCookieName, {
			...sharedOptions,
		}),
	}
	return cachedCookies
}

async function getPackageAppSessionCookie(env: Env, secure: boolean) {
	const cookies = await getPackageAppSessionCookies(env)
	return secure ? cookies.secureCookie : cookies.insecureCookie
}

/** Clears the derived cookie cache so tests can swap secrets. */
export function resetPackageAppSessionCookieForTests() {
	cachedCookies = null
}

function isStoredPackageAppSession(
	value: unknown,
): value is StoredPackageAppSession {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		record.v === 2 &&
		isStableUserId(record.stableUserId) &&
		typeof record.pkgUsername === 'string' &&
		record.pkgUsername.length > 0 &&
		typeof record.issuedAt === 'number' &&
		Number.isFinite(record.issuedAt) &&
		record.issuedAt > 0
	)
}

export async function createPackageAppSessionCookie(input: {
	env: Env
	session: PackageAppSession
	secure: boolean
	now?: number
}) {
	const cookie = await getPackageAppSessionCookie(input.env, input.secure)
	return await cookie.serialize(
		JSON.stringify({
			v: 2,
			stableUserId: input.session.stableUserId,
			pkgUsername: input.session.username,
			issuedAt: input.now ?? Date.now(),
		} satisfies StoredPackageAppSession),
		{ secure: input.secure },
	)
}

export async function destroyPackageAppSessionCookie(input: {
	env: Env
	secure: boolean
}) {
	const cookie = await getPackageAppSessionCookie(input.env, input.secure)
	return await cookie.serialize('', {
		secure: input.secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

function parseStoredPackageAppSession(
	stored: unknown,
): ParsedPackageAppSession | null {
	if (!stored || typeof stored !== 'string') return null
	try {
		const parsed: unknown = JSON.parse(stored)
		if (!isStoredPackageAppSession(parsed)) return null
		return {
			session: {
				stableUserId: parsed.stableUserId,
				username: parsed.pkgUsername,
			},
			issuedAt: parsed.issuedAt,
		}
	} catch {
		return null
	}
}

export async function readPackageAppSession(input: {
	request: Request
	env: Env
}): Promise<ParsedPackageAppSession | null> {
	const cookieHeader = input.request.headers.get('Cookie')
	if (!cookieHeader) return null

	const cookies = await getPackageAppSessionCookies(input.env)
	const secureSession = parseStoredPackageAppSession(
		await cookies.secureCookie.parse(cookieHeader),
	)
	if (secureSession) return secureSession
	return parseStoredPackageAppSession(
		await cookies.insecureCookie.parse(cookieHeader),
	)
}
