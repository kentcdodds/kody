import {
	type AuthRequest,
	type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { createCookie } from '@remix-run/cookie'
import { getRequestIp, logAuditEvent } from '#app/audit-log.ts'
import {
	isSecureRequest,
	readAuthSessionResult,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { getEnv } from '#app/env.ts'
import { Layout } from '#app/layout.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { render } from '#app/render.ts'
import { runSavedSkill } from '#mcp/skills/run-saved-skill.ts'
import { resolveSkillRunnerUserByToken } from '#mcp/values/skill-runner-tokens.ts'
import { createDb, usersTable } from './db.ts'
import { wantsJson } from './utils.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'
import { invalidClientIdMismatchMessage } from '@kody-internal/shared/oauth-messages.ts'

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

type OAuthClientResetVerification = {
	clientId: string
	reason: 'invalid-client-id-mismatch'
}

function renderSpaShell(status = 200) {
	return render(Layout({}), { status })
}

const dummyPasswordHash =
	'pbkdf2_sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000'
const oauthClientResetVerificationCookieName = 'kody_oauth_client_reset'
const oauthClientResetVerificationMaxAgeSeconds = 60 * 5
const oauthClientResetVerificationCookiePath = '/oauth'

let oauthClientResetVerificationCookie: ReturnType<typeof createCookie> | null =
	null
let oauthClientResetVerificationCookieSecret: string | null = null

function jsonResponse(data: unknown, init?: ResponseInit) {
	const headers = new Headers(init?.headers)
	headers.set('Content-Type', 'application/json')
	return new Response(JSON.stringify(data), {
		...init,
		headers,
	})
}

function getOAuthHelpers(env: Env) {
	const helpers = (env as OAuthEnv).OAUTH_PROVIDER
	if (!helpers) {
		throw new Error('OAuth provider helpers are not available.')
	}
	return helpers
}

function getOAuthClientResetVerificationCookie(secret: string) {
	if (
		oauthClientResetVerificationCookie &&
		oauthClientResetVerificationCookieSecret === secret
	) {
		return oauthClientResetVerificationCookie
	}

	oauthClientResetVerificationCookieSecret = secret
	oauthClientResetVerificationCookie = createCookie(
		oauthClientResetVerificationCookieName,
		{
			httpOnly: true,
			sameSite: 'Lax',
			path: oauthClientResetVerificationCookiePath,
			maxAge: oauthClientResetVerificationMaxAgeSeconds,
			secrets: [secret],
		},
	)
	return oauthClientResetVerificationCookie
}

function isOAuthClientResetVerification(
	value: unknown,
): value is OAuthClientResetVerification {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		typeof record.clientId === 'string' &&
		record.clientId.length > 0 &&
		record.reason === 'invalid-client-id-mismatch'
	)
}

function requestHasOAuthClientResetVerificationCookie(request: Request) {
	const cookieHeader = request.headers.get('Cookie')
	return (
		cookieHeader?.includes(`${oauthClientResetVerificationCookieName}=`) ??
		false
	)
}

async function createOAuthClientResetVerificationCookie(
	request: Request,
	env: Env,
	verification: OAuthClientResetVerification,
) {
	const appEnv = getEnv(env)
	return getOAuthClientResetVerificationCookie(appEnv.COOKIE_SECRET).serialize(
		JSON.stringify(verification),
		{
			secure: isSecureRequest(request),
		},
	)
}

async function destroyOAuthClientResetVerificationCookie(
	request: Request,
	env: Env,
) {
	const appEnv = getEnv(env)
	return getOAuthClientResetVerificationCookie(appEnv.COOKIE_SECRET).serialize(
		'',
		{
			secure: isSecureRequest(request),
			maxAge: 0,
			expires: new Date(0),
		},
	)
}

async function readOAuthClientResetVerification(
	request: Request,
	env: Env,
): Promise<OAuthClientResetVerification | null> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) return null

	const appEnv = getEnv(env)
	const stored = await getOAuthClientResetVerificationCookie(
		appEnv.COOKIE_SECRET,
	).parse(cookieHeader)
	if (!stored || typeof stored !== 'string') return null

	try {
		const parsed = JSON.parse(stored)
		return isOAuthClientResetVerification(parsed) ? parsed : null
	} catch {
		return null
	}
}

function createSetCookieHeaders(cookies: Array<string | null | undefined>) {
	const headers = new Headers()
	let hasCookie = false
	for (const cookie of cookies) {
		if (!cookie) continue
		headers.append('Set-Cookie', cookie)
		hasCookie = true
	}
	return hasCookie ? headers : undefined
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

function readClientIdFromAuthorizeRequest(request: Request) {
	const clientId = new URL(request.url).searchParams.get('client_id')?.trim()
	return clientId ? clientId : null
}

function isLoopbackHostname(hostname: string) {
	return (
		hostname === 'localhost' ||
		hostname === '::1' ||
		hostname.startsWith('127.')
	)
}

function redirectUriMatchesRegisteredUri(
	requestUri: string,
	registeredUris: Array<string>,
) {
	return registeredUris.some((registeredUri) => {
		try {
			const requestUrl = new URL(requestUri)
			const registeredUrl = new URL(registeredUri)
			if (
				isLoopbackHostname(requestUrl.hostname) &&
				isLoopbackHostname(registeredUrl.hostname)
			) {
				return (
					requestUrl.protocol === registeredUrl.protocol &&
					requestUrl.hostname === registeredUrl.hostname &&
					requestUrl.pathname === registeredUrl.pathname &&
					requestUrl.search === registeredUrl.search
				)
			}
		} catch {
			return false
		}
		return requestUri === registeredUri
	})
}

async function requestHasRedirectUriMismatch(
	helpers: OAuthHelpers,
	request: Request,
) {
	const url = new URL(request.url)
	const clientId = url.searchParams.get('client_id')?.trim()
	const redirectUri = url.searchParams.get('redirect_uri')?.trim()
	if (!clientId || !redirectUri) return false
	const client = await helpers.lookupClient(clientId)
	if (!client) return false
	return !redirectUriMatchesRegisteredUri(redirectUri, client.redirectUris)
}

async function listUserGrantsForClient(
	helpers: OAuthHelpers,
	userId: string,
	clientId: string,
) {
	const grants = new Array<{ id: string }>()
	let cursor: string | undefined

	do {
		const page = await helpers.listUserGrants(userId, { cursor })
		for (const grant of page.items) {
			if (grant.clientId === clientId) {
				grants.push({ id: grant.id })
			}
		}
		cursor = page.cursor
	} while (cursor)

	return grants
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

async function resolveAuthorizeInfoResetState(
	request: Request,
	env: Env,
	helpers: OAuthHelpers,
	errorMessage: string,
) {
	const shouldClearVerificationCookie =
		requestHasOAuthClientResetVerificationCookie(request)
	const redirectUriMismatch = await requestHasRedirectUriMismatch(
		helpers,
		request,
	)
	if (redirectUriMismatch) {
		return {
			allowClientReset: true,
			setCookie: shouldClearVerificationCookie
				? await destroyOAuthClientResetVerificationCookie(request, env)
				: null,
		}
	}

	if (errorMessage === invalidClientIdMismatchMessage) {
		const clientId = readClientIdFromAuthorizeRequest(request)
		if (clientId) {
			return {
				allowClientReset: true,
				setCookie: await createOAuthClientResetVerificationCookie(
					request,
					env,
					{
						clientId,
						reason: 'invalid-client-id-mismatch',
					},
				),
			}
		}
	}

	return {
		allowClientReset: false,
		setCookie: shouldClearVerificationCookie
			? await destroyOAuthClientResetVerificationCookie(request, env)
			: null,
	}
}

async function handleResetClientRequest(
	request: Request,
	env: Env,
	helpers: OAuthHelpers,
	requestIp?: string,
) {
	const clientId = readClientIdFromAuthorizeRequest(request)
	const hasResetVerificationCookie =
		requestHasOAuthClientResetVerificationCookie(request)
	const verifiedClientReset = await readOAuthClientResetVerification(
		request,
		env,
	)
	const clearResetVerificationCookie = hasResetVerificationCookie
		? await destroyOAuthClientResetVerificationCookie(request, env)
		: null
	const redirectUriMismatch = await requestHasRedirectUriMismatch(
		helpers,
		request,
	)
	const canResetStoredClient =
		redirectUriMismatch ||
		(clientId !== null && verifiedClientReset?.clientId === clientId)
	if (!canResetStoredClient) {
		return respondAuthorizeError(
			request,
			'Stored client cleanup is only available for stale or mismatched client registrations.',
			400,
			'invalid_request',
			createSetCookieHeaders([clearResetVerificationCookie]),
		)
	}

	if (!clientId) {
		return respondAuthorizeError(
			request,
			'Missing client ID for stored client cleanup.',
			400,
			'invalid_request',
			createSetCookieHeaders([clearResetVerificationCookie]),
		)
	}

	const { email: sessionEmail, setCookie } = await resolveSessionEmail(
		request,
		env,
	)
	if (!sessionEmail) {
		void logAuditEvent({
			category: 'oauth',
			action: 'reset_client',
			result: 'failure',
			ip: requestIp,
			clientId,
			reason: 'missing_session',
		})
		return respondAuthorizeError(
			request,
			'Sign in before deleting stored client records.',
			401,
			'unauthorized',
			createSetCookieHeaders([clearResetVerificationCookie]),
		)
	}

	try {
		const userId = await createStableUserIdFromEmail(sessionEmail)
		const grants = await listUserGrantsForClient(helpers, userId, clientId)
		await Promise.all(
			grants.map((grant) => helpers.revokeGrant(grant.id, userId)),
		)
		await helpers.deleteClient(clientId)
		void logAuditEvent({
			category: 'oauth',
			action: 'reset_client',
			result: 'success',
			email: sessionEmail,
			ip: requestIp,
			clientId,
		})
		return jsonResponse(
			{
				ok: true,
				message:
					'Deleted the stored client records for this connection. Start the connection again from your client to create a fresh trusted client.',
			},
			{
				headers: createSetCookieHeaders([
					clearResetVerificationCookie,
					setCookie,
				]),
			},
		)
	} catch (error) {
		void logAuditEvent({
			category: 'oauth',
			action: 'reset_client',
			result: 'failure',
			email: sessionEmail,
			ip: requestIp,
			clientId,
			reason: error instanceof Error ? error.message : 'unknown_error',
		})
		return respondAuthorizeError(
			request,
			'Unable to delete stored client records right now.',
			500,
			'server_error',
			createSetCookieHeaders([clearResetVerificationCookie]),
		)
	}
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
	headersInit?: HeadersInit,
) {
	const redirectUrl = new URL(request.url)
	redirectUrl.searchParams.set('error', error)
	redirectUrl.searchParams.set('error_description', description)
	const headers = new Headers(headersInit)
	headers.set('Location', redirectUrl.toString())
	return new Response(null, {
		status: 303,
		headers,
	})
}

function respondAuthorizeError(
	request: Request,
	message: string,
	status = 400,
	errorCode = 'invalid_request',
	headers?: HeadersInit,
) {
	return wantsJson(request)
		? jsonResponse(
				{ ok: false, error: message, code: errorCode },
				{ status, headers },
			)
		: createAuthorizeErrorRedirect(request, errorCode, message, headers)
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
		const { allowClientReset, setCookie } =
			await resolveAuthorizeInfoResetState(
				request,
				env,
				helpers,
				resolution.error ?? 'Unable to parse OAuth request.',
			)
		return jsonResponse(
			{ ok: false, error: resolution.error, allowClientReset },
			{
				status: 400,
				headers: createSetCookieHeaders([setCookie]),
			},
		)
	}

	const { authRequest, client } = resolution
	const clearResetVerificationCookie =
		requestHasOAuthClientResetVerificationCookie(request)
			? await destroyOAuthClientResetVerificationCookie(request, env)
			: null
	const resolvedScopes = resolveScopes(authRequest.scope)
	if (!Array.isArray(resolvedScopes)) {
		return jsonResponse(
			{ ok: false, error: resolvedScopes.error, allowClientReset: false },
			{
				status: 400,
				headers: createSetCookieHeaders([clearResetVerificationCookie]),
			},
		)
	}

	return jsonResponse(
		{
			ok: true,
			client: {
				id: client.clientId,
				name: client.clientName ?? client.clientId,
			},
			scopes: resolvedScopes,
		},
		{
			headers: createSetCookieHeaders([clearResetVerificationCookie]),
		},
	)
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
	const formData = await request.formData()
	const decision = String(formData.get('decision') ?? 'approve')
	if (decision === 'reset-client') {
		return handleResetClientRequest(request, env, helpers, requestIp)
	}

	const resolution = await resolveAuthRequest(helpers, request)
	if ('error' in resolution) {
		return respondAuthorizeError(
			request,
			resolution.error ?? 'Unable to process OAuth request.',
		)
	}

	const { authRequest } = resolution
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
		const userId = await createStableUserIdFromEmail(approvedEmail)
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
				{
					headers: createSetCookieHeaders([setCookie]),
				},
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

function readBearerToken(request: Request) {
	const header = request.headers.get('Authorization')?.trim()
	if (!header) return null
	const match = header.match(/^Bearer\s+(.+)$/i)
	const token = match?.[1]?.trim()
	return token ? token : null
}

async function handleSkillRunnerRequest(request: Request, env: Env) {
	if (request.method !== 'POST') {
		return jsonResponse({ ok: false, error: 'Method not allowed.' }, { status: 405 })
	}

	const token = readBearerToken(request)
	if (!token) {
		return jsonResponse(
			{ ok: false, error: 'Unauthorized.' },
			{
				status: 401,
				headers: {
					'WWW-Authenticate': 'Bearer',
				},
			},
		)
	}

	const authorizedUser = await resolveSkillRunnerUserByToken({
		env,
		token,
	})
	if (!authorizedUser) {
		return jsonResponse(
			{ ok: false, error: 'Unauthorized.' },
			{
				status: 401,
				headers: {
					'WWW-Authenticate': 'Bearer',
				},
			},
		)
	}

	const body = await request.json().catch(() => null)
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return jsonResponse({ ok: false, error: 'Invalid request body.' }, { status: 400 })
	}
	const payload = body as Record<string, unknown>

	const name = typeof payload['name'] === 'string' ? payload['name'].trim() : ''
	if (!name) {
		return jsonResponse({ ok: false, error: 'Skill name is required.' }, { status: 400 })
	}

	const paramsRaw = payload['params']
	const params =
		paramsRaw === undefined
			? undefined
			: paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw)
				? (paramsRaw as Record<string, unknown>)
				: null
	if (params === null) {
		return jsonResponse(
			{ ok: false, error: 'Skill params must be a JSON object when provided.' },
			{ status: 400 },
		)
	}

	try {
		const result = await runSavedSkill({
			env,
			callerContext: {
				baseUrl: new URL(request.url).origin,
				user: {
					userId: authorizedUser.userId,
					email: 'skill-runner@local.invalid',
					displayName: 'skill-runner',
				},
				homeConnectorId: null,
				remoteConnectors: null,
				storageContext: null,
			},
			name,
			params,
		})
		return result.ok
			? jsonResponse({ ok: true, result: result.result })
			: jsonResponse({
					ok: false,
					error: result.error ?? 'Skill execution failed.',
				})
	} catch (error) {
		return jsonResponse({
			ok: false,
			error: error instanceof Error ? error.message : 'Skill execution failed.',
		})
	}
}

export const apiHandler = {
	async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
		const url = new URL(request.url)
		if (url.pathname === '/api/skills/run') {
			return handleSkillRunnerRequest(request, env as Env)
		}
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
