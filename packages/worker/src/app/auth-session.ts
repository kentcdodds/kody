import { createCookie } from '@remix-run/cookie'

const defaultSessionMaxAgeSeconds = 60 * 60 * 24 * 7
const rememberedSessionMaxAgeSeconds = 60 * 60 * 24 * 30
const rememberedSessionRenewAfterMs = 1000 * 60 * 60 * 24 * 14

export type AuthSession = {
	id: string
	email: string
	rememberMe: boolean
}

type StoredAuthSession = {
	id: string
	email: string
	rememberMe?: boolean
	issuedAt?: number
}

export type AuthSessionResult = {
	session: AuthSession | null
	setCookie: string | null
}

let sessionCookie: ReturnType<typeof createCookie> | null = null
let sessionSecret: string | null = null

export function setAuthSessionSecret(secret: string) {
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for session signing.')
	}

	if (sessionCookie && sessionSecret === secret) {
		return
	}

	sessionSecret = secret
	sessionCookie = createCookie('kody_session', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: defaultSessionMaxAgeSeconds,
		secrets: [secret],
	})
}

function getSessionCookie() {
	if (!sessionCookie) {
		throw new Error('Session cookie not configured. Call setAuthSessionSecret.')
	}

	return sessionCookie
}

function isStoredAuthSession(value: unknown): value is StoredAuthSession {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		typeof record.id === 'string' &&
		record.id.length > 0 &&
		typeof record.email === 'string' &&
		record.email.length > 0 &&
		(record.rememberMe === undefined ||
			typeof record.rememberMe === 'boolean') &&
		(record.issuedAt === undefined ||
			(typeof record.issuedAt === 'number' &&
				Number.isFinite(record.issuedAt) &&
				record.issuedAt > 0))
	)
}

function getSessionMaxAgeSeconds(session: Pick<AuthSession, 'rememberMe'>) {
	return session.rememberMe
		? rememberedSessionMaxAgeSeconds
		: defaultSessionMaxAgeSeconds
}

function createStoredAuthSession(
	session: AuthSession,
	now: number,
): StoredAuthSession {
	if (!session.rememberMe) {
		return {
			id: session.id,
			email: session.email,
		}
	}

	return {
		id: session.id,
		email: session.email,
		rememberMe: true,
		issuedAt: now,
	}
}

function normalizeAuthSession(session: StoredAuthSession): AuthSession {
	return {
		id: session.id,
		email: session.email,
		rememberMe: session.rememberMe === true,
	}
}

function shouldRenewRememberedSession(session: StoredAuthSession, now: number) {
	if (!session.rememberMe || typeof session.issuedAt !== 'number') {
		return false
	}

	return now - session.issuedAt >= rememberedSessionRenewAfterMs
}

function normalizeProto(value: string) {
	return value.trim().replace(/^"|"$/g, '').toLowerCase()
}

function getForwardedProto(request: Request) {
	const forwarded = request.headers.get('forwarded')
	if (forwarded) {
		for (const entry of forwarded.split(',')) {
			for (const pair of entry.split(';')) {
				const [key, rawValue] = pair.split('=')
				if (!key || !rawValue) continue
				if (key.trim().toLowerCase() === 'proto') {
					return normalizeProto(rawValue)
				}
			}
		}
	}

	const xForwardedProto = request.headers.get('x-forwarded-proto')
	if (xForwardedProto) {
		return normalizeProto(xForwardedProto.split(',')[0] ?? '')
	}

	return null
}

export function isSecureRequest(request: Request) {
	const forwardedProto = getForwardedProto(request)
	if (forwardedProto) {
		return forwardedProto === 'https'
	}

	return new URL(request.url).protocol === 'https:'
}

export async function createAuthCookie(
	session: AuthSession,
	secure: boolean,
	now = Date.now(),
) {
	return getSessionCookie().serialize(
		JSON.stringify(createStoredAuthSession(session, now)),
		{
			secure,
			maxAge: getSessionMaxAgeSeconds(session),
		},
	)
}

export async function destroyAuthCookie(secure: boolean) {
	return getSessionCookie().serialize('', {
		secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

export async function readAuthSessionResult(
	request: Request,
	now = Date.now(),
): Promise<AuthSessionResult> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) {
		return { session: null, setCookie: null }
	}

	const stored = await getSessionCookie().parse(cookieHeader)
	if (!stored || typeof stored !== 'string') {
		return { session: null, setCookie: null }
	}

	try {
		const parsed = JSON.parse(stored)
		if (isStoredAuthSession(parsed)) {
			const session = normalizeAuthSession(parsed)
			const setCookie = shouldRenewRememberedSession(parsed, now)
				? await createAuthCookie(session, isSecureRequest(request), now)
				: null
			return { session, setCookie }
		}
	} catch {
		return { session: null, setCookie: null }
	}

	return { session: null, setCookie: null }
}
