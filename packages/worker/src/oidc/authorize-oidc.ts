import { destroyAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { verifyOidcJwtSignature } from '#worker/oidc/keys.ts'

export type OidcAuthorizeParams = {
	nonce?: string
	prompt?: string
	maxAge?: number
	idTokenHint?: string
	responseType: string
}

export type OidcAuthorizeSessionContext = {
	sessionEmail: string | null
	sessionStableUserId: string | null
	sessionIssuedAt: number | undefined
}

export type OidcAuthorizeGateResult =
	| {
			ok: true
			treatAsSignedOut: boolean
			clearSessionCookie?: string | null
			forbidInlineLogin?: boolean
			requireConsent?: boolean
	  }
	| {
			ok: false
			error: string
			errorCode: string
			status?: number
	  }

export function parseOidcAuthorizeParams(
	request: Request,
): OidcAuthorizeParams {
	const url = new URL(request.url)
	const maxAgeRaw = url.searchParams.get('max_age')?.trim()
	let maxAge: number | undefined
	if (maxAgeRaw) {
		const parsed = Number.parseInt(maxAgeRaw, 10)
		if (Number.isFinite(parsed) && parsed >= 0) {
			maxAge = parsed
		}
	}
	return {
		nonce: url.searchParams.get('nonce')?.trim() || undefined,
		prompt: url.searchParams.get('prompt')?.trim() || undefined,
		maxAge,
		idTokenHint: url.searchParams.get('id_token_hint')?.trim() || undefined,
		responseType: url.searchParams.get('response_type')?.trim() || 'code',
	}
}

export function getUnsupportedOidcResponseTypeError(responseType: string) {
	const normalized = responseType.trim()
	if (!normalized || normalized === 'code') return null
	const types = normalized.split(/\s+/)
	if (types.some((type) => type === 'id_token' || type === 'token')) {
		return 'Unsupported response type. Only authorization code (code) is supported.'
	}
	if (normalized !== 'code') {
		return `Unsupported response type: ${normalized}`
	}
	return null
}

function isJwtExpired(payload: Record<string, unknown>, nowSeconds: number) {
	const exp = payload.exp
	return typeof exp === 'number' && Number.isFinite(exp) && nowSeconds >= exp
}

async function readIdTokenHintSubject(input: {
	env: Env
	request: Request
	idTokenHint: string
}) {
	const issuer = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	const payload = await verifyOidcJwtSignature(input.env, input.idTokenHint)
	if (!payload || payload.iss !== issuer) return null
	const nowSeconds = Math.floor(Date.now() / 1000)
	if (isJwtExpired(payload, nowSeconds)) return null
	return typeof payload.sub === 'string' ? payload.sub : null
}

export async function evaluateOidcAuthorizeGate(input: {
	params: OidcAuthorizeParams
	session: OidcAuthorizeSessionContext
	request: Request
	env: Env
}): Promise<OidcAuthorizeGateResult> {
	const responseTypeError = getUnsupportedOidcResponseTypeError(
		input.params.responseType,
	)
	if (responseTypeError) {
		return {
			ok: false,
			error: responseTypeError,
			errorCode: 'unsupported_response_type',
		}
	}

	const prompts = input.params.prompt?.split(/\s+/).filter(Boolean) ?? []
	const wantsLogin = prompts.includes('login')
	const wantsNone = prompts.includes('none')
	const wantsConsent = prompts.includes('consent')

	if (wantsNone && (wantsLogin || wantsConsent)) {
		return {
			ok: false,
			error: 'prompt=none cannot be combined with login or consent.',
			errorCode: 'invalid_request',
			status: 400,
		}
	}

	if (wantsLogin) {
		const clearSessionCookie = await destroyAuthCookie(
			isSecureRequest(input.request),
		)
		return {
			ok: true,
			treatAsSignedOut: true,
			clearSessionCookie,
			requireConsent: wantsConsent,
		}
	}

	let signedIn = Boolean(input.session.sessionEmail)

	if (signedIn && input.params.maxAge !== undefined) {
		// Fail closed: without a known auth_time, max_age cannot be evaluated.
		if (input.session.sessionIssuedAt === undefined) {
			signedIn = false
		} else {
			const authTimeSeconds = Math.floor(input.session.sessionIssuedAt / 1000)
			const nowSeconds = Math.floor(Date.now() / 1000)
			if (nowSeconds - authTimeSeconds > input.params.maxAge) {
				signedIn = false
			}
		}
	}

	if (input.params.idTokenHint && signedIn) {
		const hintSubject = await readIdTokenHintSubject({
			env: input.env,
			request: input.request,
			idTokenHint: input.params.idTokenHint,
		})
		if (!hintSubject || hintSubject !== input.session.sessionStableUserId) {
			signedIn = false
		}
	}

	if (wantsNone && !signedIn) {
		return {
			ok: false,
			error: 'Login required.',
			errorCode: 'login_required',
			status: 401,
		}
	}

	return {
		ok: true,
		treatAsSignedOut: !signedIn,
		forbidInlineLogin: wantsNone,
		requireConsent: wantsConsent,
	}
}
