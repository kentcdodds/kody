import { createCookie } from 'remix/cookie'
import { isSecureRequest } from '#app/auth-session.ts'
import { isStableUserId } from '#worker/user-id.ts'

/**
 * WebAuthn ceremony state. The challenge lives in a short-lived signed
 * cookie (Epic Stack pattern) instead of server-side storage, so no
 * cross-request state is needed on the worker.
 */
const challengeMaxAgeSeconds = 60 * 10

export type WebAuthnChallenge = {
	challenge: string
	webauthnUserId?: string
	/** Registration only: the app user the ceremony was started for. */
	stableUserId?: string
}

type StoredWebAuthnChallenge = WebAuthnChallenge & { v: 2 }

let challengeCookie: ReturnType<typeof createCookie> | null = null
let challengeSecret: string | null = null

export function setWebAuthnChallengeSecret(secret: string) {
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for WebAuthn challenge signing.')
	}

	if (challengeCookie && challengeSecret === secret) {
		return
	}

	challengeSecret = secret
	challengeCookie = createCookie('kody_webauthn_challenge', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: challengeMaxAgeSeconds,
		secrets: [secret],
	})
}

function getChallengeCookie() {
	if (!challengeCookie) {
		throw new Error(
			'WebAuthn challenge cookie not configured. Call setWebAuthnChallengeSecret.',
		)
	}

	return challengeCookie
}

function isWebAuthnChallenge(value: unknown): value is StoredWebAuthnChallenge {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		record.v === 2 &&
		typeof record.challenge === 'string' &&
		record.challenge.length > 0 &&
		(record.webauthnUserId === undefined ||
			typeof record.webauthnUserId === 'string') &&
		(record.stableUserId === undefined || isStableUserId(record.stableUserId))
	)
}

export async function createWebAuthnChallengeCookie(
	data: WebAuthnChallenge,
	secure: boolean,
) {
	return getChallengeCookie().serialize(
		JSON.stringify({ ...data, v: 2 } satisfies StoredWebAuthnChallenge),
		{ secure },
	)
}

export async function destroyWebAuthnChallengeCookie(secure: boolean) {
	return getChallengeCookie().serialize('', {
		secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

export async function readWebAuthnChallenge(
	request: Request,
): Promise<WebAuthnChallenge | null> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) return null

	const stored = await getChallengeCookie().parse(cookieHeader)
	if (!stored || typeof stored !== 'string') return null

	try {
		const parsed = JSON.parse(stored)
		if (isWebAuthnChallenge(parsed)) {
			return {
				challenge: parsed.challenge,
				webauthnUserId: parsed.webauthnUserId,
				stableUserId: parsed.stableUserId,
			}
		}
	} catch {
		return null
	}

	return null
}

/**
 * The relying party is derived from the request host so local dev,
 * preview, and production all work without extra configuration.
 */
export function getWebAuthnConfig(request: Request) {
	const url = new URL(request.url)
	const protocol = isSecureRequest(request) ? 'https' : 'http'
	return {
		rpName: 'kody',
		rpID: url.hostname,
		origin: `${protocol}://${url.host}`,
	}
}
