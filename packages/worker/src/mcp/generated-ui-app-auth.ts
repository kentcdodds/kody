import { createCookie } from '@remix-run/cookie'
import { isSecureRequest } from '#app/auth-session.ts'
import {
	buildSavedAppBackendBasePath,
	verifyGeneratedUiAppSession,
} from '#mcp/generated-ui-app-session.ts'

const generatedUiAppBackendCookieName = 'kody_generated_ui_app'

function getGeneratedUiAppBackendCookie(secret: string, appId: string) {
	return createCookie(generatedUiAppBackendCookieName, {
		httpOnly: true,
		sameSite: 'Lax',
		path: `${buildSavedAppBackendBasePath(appId)}/`,
		secrets: [secret],
	})
}

export async function createGeneratedUiAppBackendCookieHeader(input: {
	env: Pick<Env, 'COOKIE_SECRET'>
	request: Request
	appId: string
	token: string
	expiresAt: string
}) {
	return getGeneratedUiAppBackendCookie(
		input.env.COOKIE_SECRET,
		input.appId,
	).serialize(input.token, {
		secure: isSecureRequest(input.request),
		expires: new Date(input.expiresAt),
	})
}

export async function readGeneratedUiAppBackendSession(input: {
	env: Pick<Env, 'COOKIE_SECRET'>
	request: Request
	appId: string
}) {
	const authHeader = input.request.headers.get('Authorization')
	const bearerToken = authHeader?.startsWith('Bearer ')
		? authHeader.slice('Bearer '.length).trim()
		: null
	const cookieHeader = input.request.headers.get('Cookie')
	const cookieToken = cookieHeader
		? await getGeneratedUiAppBackendCookie(
				input.env.COOKIE_SECRET,
				input.appId,
			).parse(cookieHeader)
		: null
	const token =
		typeof bearerToken === 'string' && bearerToken.length > 0
			? bearerToken
			: typeof cookieToken === 'string' && cookieToken.length > 0
				? cookieToken
				: null
	if (!token) {
		return null
	}
	try {
		const session = await verifyGeneratedUiAppSession(input.env, token)
		if (session.app_id !== input.appId) {
			return null
		}
		return session
	} catch {
		return null
	}
}
