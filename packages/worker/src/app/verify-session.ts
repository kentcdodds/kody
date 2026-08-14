import { createCookie } from 'remix/cookie'
import { isStableUserId } from '#worker/user-id.ts'

/**
 * Short-lived signed cookie that parks a password- or passkey-verified login
 * while the second factor is outstanding. The real `kody_session` cookie is
 * only issued after the TOTP code passes, so a stolen pending cookie never
 * grants access on its own.
 */
const pendingSessionMaxAgeSeconds = 60 * 10

export type PendingTwoFactorSession = {
	stableUserId: string
	email: string
	rememberMe: boolean
}

type StoredPendingTwoFactorSession = PendingTwoFactorSession & {
	v: 2
}

let pendingCookie: ReturnType<typeof createCookie> | null = null
let pendingSecret: string | null = null

export function setVerifySessionSecret(secret: string) {
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for verification session signing.')
	}

	if (pendingCookie && pendingSecret === secret) {
		return
	}

	pendingSecret = secret
	pendingCookie = createCookie('kody_verify', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: pendingSessionMaxAgeSeconds,
		secrets: [secret],
	})
}

function getPendingCookie() {
	if (!pendingCookie) {
		throw new Error(
			'Verification cookie not configured. Call setVerifySessionSecret.',
		)
	}

	return pendingCookie
}

function isPendingTwoFactorSession(
	value: unknown,
): value is StoredPendingTwoFactorSession {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		record.v === 2 &&
		isStableUserId(record.stableUserId) &&
		typeof record.email === 'string' &&
		record.email.length > 0 &&
		typeof record.rememberMe === 'boolean'
	)
}

export async function createVerifySessionCookie(
	session: PendingTwoFactorSession,
	secure: boolean,
) {
	return getPendingCookie().serialize(
		JSON.stringify({
			...session,
			v: 2,
		} satisfies StoredPendingTwoFactorSession),
		{ secure },
	)
}

export async function destroyVerifySessionCookie(secure: boolean) {
	return getPendingCookie().serialize('', {
		secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

export async function readVerifySession(
	request: Request,
): Promise<PendingTwoFactorSession | null> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) return null

	const stored = await getPendingCookie().parse(cookieHeader)
	if (!stored || typeof stored !== 'string') return null

	try {
		const parsed = JSON.parse(stored)
		if (isPendingTwoFactorSession(parsed)) {
			return {
				stableUserId: parsed.stableUserId,
				email: parsed.email,
				rememberMe: parsed.rememberMe,
			}
		}
	} catch {
		return null
	}

	return null
}
