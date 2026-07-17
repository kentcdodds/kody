import { createCookie } from '@remix-run/cookie'
import {
	isOauthProviderId,
	type OauthProviderId,
} from '#app/oauth-providers.ts'

/**
 * Short-lived signed cookie that carries the social-login round-trip state:
 * the CSRF `state` value, the PKCE code verifier, the post-login redirect
 * target, and an optional invite code for production social signup. Written
 * when the flow starts and cleared by the callback.
 */
const oauthLoginStateMaxAgeSeconds = 60 * 10

export type OauthLoginState = {
	provider: OauthProviderId
	state: string
	codeVerifier: string
	redirectTo: string | null
	inviteCode: string | null
}

let stateCookie: ReturnType<typeof createCookie> | null = null
let stateSecret: string | null = null

export function setOauthLoginStateSecret(secret: string) {
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for OAuth login state signing.')
	}

	if (stateCookie && stateSecret === secret) {
		return
	}

	stateSecret = secret
	stateCookie = createCookie('kody_oauth_login', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: oauthLoginStateMaxAgeSeconds,
		secrets: [secret],
	})
}

function getStateCookie() {
	if (!stateCookie) {
		throw new Error(
			'OAuth login state cookie not configured. Call setOauthLoginStateSecret.',
		)
	}

	return stateCookie
}

function isOauthLoginState(value: unknown): value is OauthLoginState {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	const inviteCodeOk =
		record.inviteCode === undefined ||
		record.inviteCode === null ||
		typeof record.inviteCode === 'string'
	return (
		typeof record.provider === 'string' &&
		isOauthProviderId(record.provider) &&
		typeof record.state === 'string' &&
		record.state.length > 0 &&
		typeof record.codeVerifier === 'string' &&
		record.codeVerifier.length > 0 &&
		(record.redirectTo === null || typeof record.redirectTo === 'string') &&
		inviteCodeOk
	)
}

function normalizeOauthLoginState(value: OauthLoginState): OauthLoginState {
	return {
		...value,
		inviteCode:
			typeof value.inviteCode === 'string' && value.inviteCode.length > 0
				? value.inviteCode
				: null,
	}
}

export async function createOauthLoginStateCookie(
	state: OauthLoginState,
	secure: boolean,
) {
	return getStateCookie().serialize(
		JSON.stringify(normalizeOauthLoginState(state)),
		{ secure },
	)
}

export async function destroyOauthLoginStateCookie(secure: boolean) {
	return getStateCookie().serialize('', {
		secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

export async function readOauthLoginState(
	request: Request,
): Promise<OauthLoginState | null> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) return null

	const stored = await getStateCookie().parse(cookieHeader)
	if (!stored || typeof stored !== 'string') return null

	try {
		const parsed = JSON.parse(stored)
		if (isOauthLoginState(parsed)) {
			return normalizeOauthLoginState(parsed)
		}
	} catch {
		return null
	}

	return null
}
