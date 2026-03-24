import {
	type AuthRequest,
	type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import {
	readAuthSessionResult,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { getEnv } from '#app/env.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { createDb, usersTable } from './db.ts'
import { wantsJson } from './utils.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'

export const oauthPaths = {
	authorize: '/oauth/authorize',
	authorizeInfo: '/oauth/authorize-info',
	token: '/oauth/token',
	register: '/oauth/register',
	callback: '/oauth/callback',
	apiPrefix: '/api/',
}

export const oauthScopes: Array<string> = ['profile', 'email']

type OAuthProps = {
	userId: string
	email: string
	displayName: string
}

type OAuthEnv = Env & {
	OAUTH_PROVIDER: OAuthHelpers
}

type OAuthContext = ExecutionContext & {
	props?: OAuthProps
}

function renderSpaShell(status = 200) {
	return render(Layout({}), { status })
}

const dummyPasswordHash =
	'pbkdf2_sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000'

async function createUserId(email: string) {
	const normalized = email.trim().toLowerCase()
	const data = new TextEncoder().encode(normalized)
	const hash = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(hash))
}

function jsonResponse(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			'Content-Type': 'application/json',
			...init?.headers,
		},
	})
}

function getOAuthHelpers(env: Env) {
	const helpers = (env as OAuthEnv).OAUTH_PROVIDER
	if (!helpers) {
		throw new Error('OAuth provider helpers are not available.')
	}
	return helpers
}

async function resolveAuthRequest(helpers: OAuthHelpers, request: Request) {
	try {
		const authRequest = await helpers.parseAuthRequest(request)
		if (!authRequest.clientId || !authRequest.redirectUri) {
			return {
				error:
					'Invalid OAuth request. Client ID and redirect URI are required.',
			}
		}
		const client = await helpers.lookupClient(authRequest.clientId)
		if (!client) {
			return { error: 'Unknown OAuth client.' }
		}
		return { authRequest, client }
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unable to parse OAuth request.'
		return { error: message }
	}
}

function resolveScopes(requestedScopes: Array<string>) {
	if (requestedScopes.length === 0) return oauthScopes
	const invalidScopes = requestedScopes.filter(
		(scope) => !oauthScopes.includes(scope),
	)
	if (invalidScopes.length > 0) {
		return {
			error: `Unsupported scopes requested: ${invalidScopes.join(', ')}`,
		}
	}
	return requestedScopes
}

function createAccessDeniedRedirectUrl(request: AuthRequest) {
	if (!request.redirectUri) {
		return null
	}
	const redirectUrl = new URL(request.redirectUri)
	redirectUrl.searchParams.set('error', 'access_denied')
	if (request.state) redirectUrl.searchParams.set('state', request.state)
	return redirectUrl.toString()
}

function createAuthorizeErrorRedirect(
	request: Request,
	error: string,
	description: string,
) {
	const redirectUrl = new URL(request.url)
	redirectUrl.searchParams.set('error', error)
	redirectUrl.searchParams.set('error_description', description)
	return Response.redirect(redirectUrl.toString(), 303)
}

function respondAuthorizeError(
	request: Request,
	message: string,
	status = 400,
	errorCode = 'invalid_request',
) {
	return wantsJson(request)
		? jsonResponse({ ok: false, error: message, code: errorCode }, { status })
		: createAuthorizeErrorRedirect(request, errorCode, message)
}

async function resolveSessionEmail(request: Request, env: Env) {
	try {
		const appEnv = getEnv(env)
		setAuthSessionSecret(appEnv.COOKIE_SECRET)
		const { session, setCookie } = await readAuthSessionResult(request)
		const email = session?.email?.trim()
		return {
			email: email ? email.toLowerCase() : null,
			setCookie,
		}
	} catch {
		return {
			email: null,
			setCookie: null,
		}
	}
}

export async function handleAuthorizeInfo(
	request: Request,
	env: Env,
): Promise<Response> {
	const helpers = getOAuthHelpers(env)
	const resolution = await resolveAuthRequest(helpers, request)
	if ('error' in resolution) {
		return jsonResponse({ ok: false, error: resolution.error }, { status: 400 })
	}

	const { authRequest, client } = resolution
	const resolvedScopes = resolveScopes(authRequest.scope)
	if (!Array.isArray(resolvedScopes)) {
		return jsonResponse(
			{ ok: false, error: resolvedScopes.error },
			{ status: 400 },
		)
	}

	return jsonResponse({
		ok: true,
		client: {
			id: client.clientId,
			name: client.clientName ?? client.clientId,
		},
		scopes: resolvedScopes,
	})
}

export async function handleAuthorizeRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method === 'GET') {
		return renderSpaShell()
	}

	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 })
	}

	const requestIp = getRequestIp(request) ?? undefined
	const helpers = getOAuthHelpers(env)
	const resolution = await resolveAuthRequest(helpers, request)
	if ('error' in resolution) {
		return respondAuthorizeError(
			request,
			resolution.error ?? 'Unable to process OAuth request.',
		)
	}

	const { authRequest } = resolution
	const formData = await request.formData()
	const decision = String(formData.get('decision') ?? 'approve')
	if (decision === 'deny') {
		const redirectTo = createAccessDeniedRedirectUrl(authRequest)
		if (!redirectTo) {
			return respondAuthorizeError(
				request,
				'Missing redirect URI for access denial.',
			)
		}
		return wantsJson(request)
			? jsonResponse({ ok: true, redirectTo })
			: Response.redirect(redirectTo, 302)
	}

	const email = String(formData.get('email') ?? '').trim()
	const password = String(formData.get('password') ?? '')
	const normalizedEmail = email.toLowerCase()
	const { email: sessionEmail, setCookie } = await resolveSessionEmail(
		request,
		env,
	)
	const hasFormCredentials = Boolean(email && password)
	const hasSession = Boolean(sessionEmail)

	if (!hasFormCredentials && !hasSession) {
		void logAuditEvent({
			category: 'oauth',
			action: 'authorize',
			result: 'failure',
			email: normalizedEmail || undefined,
			ip: requestIp,
			clientId: authRequest.clientId,
			reason: 'missing_credentials',
		})
		return respondAuthorizeError(request, 'Email and password are required.')
	}

	let approvedEmail = ''
	if (hasFormCredentials) {
		const db = createDb(env.APP_DB)
		const userRecord = await db.findOne(usersTable, {
			where: { email: normalizedEmail },
		})
		let passwordValid = false
		if (userRecord) {
			passwordValid = await verifyPassword(password, userRecord.password_hash)
		} else {
			await verifyPassword(password, dummyPasswordHash)
		}

		if (!userRecord || !passwordValid) {
			void logAuditEvent({
				category: 'oauth',
				action: 'authorize',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				clientId: authRequest.clientId,
				reason: 'invalid_credentials',
			})
			return respondAuthorizeError(request, 'Invalid email or password.')
		}
		approvedEmail = normalizedEmail
	} else if (sessionEmail) {
		approvedEmail = sessionEmail
	}

	const resolvedScopes = resolveScopes(authRequest.scope)
	if (Array.isArray(resolvedScopes)) {
		const userId = await createUserId(approvedEmail)
		const displayName = approvedEmail.split('@')[0] || 'user'
		const { redirectTo } = await helpers.completeAuthorization({
			request: authRequest,
			userId,
			metadata: {
				email: approvedEmail,
				clientId: authRequest.clientId,
			},
			scope: resolvedScopes,
			props: {
				userId,
				email: approvedEmail,
				displayName,
			},
		})
		void logAuditEvent({
			category: 'oauth',
			action: 'authorize',
			result: 'success',
			email: approvedEmail,
			ip: requestIp,
			clientId: authRequest.clientId,
		})
		if (wantsJson(request)) {
			return jsonResponse(
				{ ok: true, redirectTo },
				setCookie
					? {
							headers: {
								'Set-Cookie': setCookie,
							},
						}
					: undefined,
			)
		}

		if (setCookie) {
			return new Response(null, {
				status: 302,
				headers: {
					Location: redirectTo,
					'Set-Cookie': setCookie,
				},
			})
		}

		return Response.redirect(redirectTo, 302)
	}

	return respondAuthorizeError(request, resolvedScopes.error)
}

export function handleOAuthCallback(request: Request): Response {
	const url = new URL(request.url)
	const hasError =
		url.searchParams.has('error') || url.searchParams.has('error_description')
	return renderSpaShell(hasError ? 400 : 200)
}

export const apiHandler = {
	async fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
		const url = new URL(request.url)
		if (url.pathname === '/api/me') {
			const props = (ctx as OAuthContext).props
			if (!props) {
				return jsonResponse(
					{ ok: false, error: 'Unauthorized' },
					{ status: 401 },
				)
			}
			return jsonResponse({ ok: true, user: props })
		}

		return jsonResponse({ error: 'Not found' }, { status: 404 })
	},
} satisfies ExportedHandler
