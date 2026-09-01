import { jsonResponse } from '#worker/json-response.ts'
import * as Sentry from '@sentry/cloudflare'
import {
	type AuthRequest,
	CimdFetchError,
	type ClientInfo,
	type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { createCookie } from 'remix/cookie'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import {
	createAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
	readParsedAuthSession,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { isAccountEmailVerified } from '#worker/identity/email-verification-state.ts'
import { getEnv } from '#app/env.ts'
import { type OAuthAuthorizeLoaderData } from '#universal/loader-data.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { resolveUserStableId } from '#worker/user-id.ts'
import { createDb, usersTable } from './db.ts'
import { upgradePasswordHashIfNeeded } from './password-upgrade.ts'
import { wantsJson } from './utils.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'
import { invalidClientIdMismatchMessage } from '@kody-internal/shared/oauth-messages.ts'
import { getUsernameFormatValidationError } from '#worker/identity/username.ts'
import { getPkceValidationError } from '#worker/oauth-pkce.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { mcpResourcePath } from './mcp-auth.ts'
import { listUserOAuthGrantsForClient } from '#worker/oauth-grants.ts'
import {
	markUserMcpOauthClientRevokedByClientId,
	userOwnsMcpOauthClient,
} from '#app/account-mcp-oauth-clients.ts'
import { mcpOauthScopes } from '#worker/mcp-oauth-scopes.ts'
import {
	evaluateOidcAuthorizeGate,
	isOidcAuthorizeParamsParseError,
	parseOidcAuthorizeParams,
} from '#worker/oidc/authorize-oidc.ts'

export { oauthPaths }

export const oauthScopes = mcpOauthScopes
const invalidOAuthClientRegistrationMessage =
	'Invalid OAuth client registration.'
export const oauthEmailVerificationRequiredMessage =
	'Verify your account email before authorizing MCP access. Keep this page open, resend or open the verification link from Account in another tab, then continue.'

type OAuthProps = {
	userId: string
	email: string
	username: string
	displayName: string
	authTime: number
	nonce?: string
}

type OAuthEnv = Env & {
	OAUTH_PROVIDER: OAuthHelpers
}

type OAuthContext = ExecutionContext & {
	props?: OAuthProps
}

function getValidOAuthUsername(value: unknown) {
	return typeof value === 'string' &&
		!getUsernameFormatValidationError(value.trim())
		? value.trim()
		: null
}

type OAuthClientResetVerification = {
	clientId: string
	reason: 'invalid-client-id-mismatch'
}

function renderSpaShell(
	request: Request,
	env: Env,
	options: {
		status?: number
		loaderData?: { oauthAuthorize: OAuthAuthorizeLoaderData }
		setCookie?: string | null
	} = {},
) {
	const { status = 200, loaderData, setCookie } = options
	return renderAppPage({
		request,
		env,
		status,
		loaderData,
		extraSetCookies: setCookie ? [setCookie] : undefined,
	})
}

const dummyPasswordHash =
	'pbkdf2_sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000'
const oauthClientResetVerificationCookieName = 'kody_oauth_client_reset'
const oauthClientResetVerificationMaxAgeSeconds = 60 * 5
const oauthClientResetVerificationCookiePath = '/oauth'

let oauthClientResetVerificationCookie: ReturnType<typeof createCookie> | null =
	null
let oauthClientResetVerificationCookieSecret: string | null = null

function standaloneAuthorizeErrorHtmlResponse(message: string, status: number) {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OAuth authorization failed</title></head><body><main style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><p style="font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#57606a">Kody secure connection</p><h1>Authorize access</h1><p>${message}</p><p><a href="/">Back home</a></p></main></body></html>`,
		{
			status,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/html; charset=utf-8',
			},
		},
	)
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

function defaultMcpResourceForAuthRequest(
	authRequest: AuthRequest,
	request: Request,
	env: Env,
) {
	// Gemini Spark (and some other MCP hosts) omit RFC 8707 `resource` on
	// authorize. Without a grant resource, token exchange can mint a token with
	// no audience, and `/mcp` rejects it. Default to the MCP resource when the
	// client did not send one; explicit `resource` values are left unchanged.
	if (authRequest.resource !== undefined) return
	const origin = getAppBaseUrl({
		env,
		requestUrl: request.url,
	})
	authRequest.resource = `${origin}${mcpResourcePath}`
}

function isCimdMetadataResolutionError(error: unknown) {
	return (
		error instanceof CimdFetchError ||
		(error instanceof Error &&
			error.name === 'CimdFetchError' &&
			'metadataUrl' in error)
	)
}

async function resolveAuthRequest(
	helpers: OAuthHelpers,
	request: Request,
	env: Env,
) {
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
		defaultMcpResourceForAuthRequest(authRequest, request, env)
		return { authRequest, client }
	} catch (error) {
		if (isCimdMetadataResolutionError(error)) {
			Sentry.captureException(error)
			return { error: 'Unknown OAuth client.' }
		}
		const message =
			error instanceof TypeError
				? invalidOAuthClientRegistrationMessage
				: error instanceof Error
					? error.message
					: 'Unable to parse OAuth request.'
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

function readRegisteredRedirectUris(client: ClientInfo) {
	const redirectUris = (client as { redirectUris?: unknown }).redirectUris
	return Array.isArray(redirectUris) &&
		redirectUris.every((uri) => typeof uri === 'string')
		? redirectUris
		: null
}

async function requestHasRedirectUriMismatch(
	helpers: OAuthHelpers,
	request: Request,
) {
	const url = new URL(request.url)
	const clientId = url.searchParams.get('client_id')?.trim()
	const redirectUri = url.searchParams.get('redirect_uri')?.trim()
	if (!clientId || !redirectUri) return false
	let client: ClientInfo | null
	try {
		client = await helpers.lookupClient(clientId)
	} catch {
		return false
	}
	if (!client) return false
	const registeredUris = readRegisteredRedirectUris(client)
	if (!registeredUris) return true
	return !redirectUriMatchesRegisteredUri(redirectUri, registeredUris)
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
			'Sign in before resetting this connection.',
			401,
			'unauthorized',
			createSetCookieHeaders([clearResetVerificationCookie]),
		)
	}

	try {
		const db = createDb(env.APP_DB)
		const userRecord = await db.findOne(usersTable, {
			where: { email: sessionEmail },
		})
		if (!userRecord) {
			void logAuditEvent({
				category: 'oauth',
				action: 'reset_client',
				result: 'failure',
				email: sessionEmail,
				ip: requestIp,
				clientId,
				reason: 'user_not_found',
			})
			return respondAuthorizeError(
				request,
				'Signed-in user not found.',
				401,
				'unauthorized',
				createSetCookieHeaders([clearResetVerificationCookie]),
			)
		}
		const userId = resolveUserStableId(userRecord)
		const grants = await listUserOAuthGrantsForClient(helpers, userId, clientId)
		await Promise.all(
			grants.map((grant) => helpers.revokeGrant(grant.id, userId)),
		)
		const ownsClient = await userOwnsMcpOauthClient(
			env.APP_DB,
			userRecord.id,
			clientId,
		)
		if (ownsClient) {
			await helpers.deleteClient(clientId)
			await markUserMcpOauthClientRevokedByClientId(
				env.APP_DB,
				userRecord.id,
				clientId,
			)
		}
		void logAuditEvent({
			category: 'oauth',
			action: 'reset_client',
			result: 'success',
			email: sessionEmail,
			ip: requestIp,
			clientId,
			reason: ownsClient ? 'deleted_owned_client' : 'revoked_grants_only',
		})
		return jsonResponse(
			{
				ok: true,
				message: ownsClient
					? "Deleted your stored client registration and revoked this account's grants. Start the connection again from your client to create a fresh trusted client."
					: "Revoked this account's grants for the client. Shared client registrations stay in place. Start the connection again from your client.",
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
			'Unable to reset this connection right now.',
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

function createOidcClientErrorRedirectUrl(
	authRequest: AuthRequest,
	errorCode: string,
	description: string,
) {
	if (!authRequest.redirectUri) return null
	const redirectUrl = new URL(authRequest.redirectUri)
	redirectUrl.searchParams.set('error', errorCode)
	redirectUrl.searchParams.set('error_description', description)
	if (authRequest.state)
		redirectUrl.searchParams.set('state', authRequest.state)
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
			session,
			email: email ? email.toLowerCase() : null,
			setCookie,
		}
	} catch {
		return {
			session: null,
			email: null,
			setCookie: null,
		}
	}
}

async function resolveAuthorizeSession(request: Request, env: Env) {
	try {
		const appEnv = getEnv(env)
		setAuthSessionSecret(appEnv.COOKIE_SECRET)
		const parsed = await readParsedAuthSession(request)
		if (!parsed) {
			return {
				session: null,
				email: null,
				stableUserId: null,
				issuedAt: undefined,
				setCookie: null,
			}
		}
		const email = parsed.session.email.trim().toLowerCase()
		return {
			session: parsed.session,
			email,
			stableUserId: parsed.session.stableUserId,
			issuedAt: parsed.issuedAt,
			setCookie: parsed.setCookie,
		}
	} catch {
		return {
			session: null,
			email: null,
			stableUserId: null,
			issuedAt: undefined,
			setCookie: null,
		}
	}
}

export type OAuthAuthorizeDataResult = {
	data: OAuthAuthorizeLoaderData
	setCookie: string | null
}

export async function loadOAuthAuthorizeData(
	request: Request,
	env: Env,
): Promise<OAuthAuthorizeDataResult> {
	const oidcParamsOrError = parseOidcAuthorizeParams(request)
	if (isOidcAuthorizeParamsParseError(oidcParamsOrError)) {
		return {
			data: {
				ok: false,
				error: oidcParamsOrError.error,
				allowClientReset: false,
			},
			setCookie: null,
		}
	}
	const oidcParams = oidcParamsOrError
	const helpers = getOAuthHelpers(env)
	const resolution = await resolveAuthRequest(helpers, request, env)
	if ('error' in resolution) {
		const { allowClientReset, setCookie } =
			await resolveAuthorizeInfoResetState(
				request,
				env,
				helpers,
				resolution.error ?? 'Unable to parse OAuth request.',
			)
		return {
			data: {
				ok: false,
				error: resolution.error ?? 'Unable to parse OAuth request.',
				allowClientReset,
			},
			setCookie,
		}
	}

	const oidcGate = await evaluateOidcAuthorizeGate({
		params: oidcParams,
		session: await resolveAuthorizeSession(request, env).then((session) => ({
			sessionEmail: session.email,
			sessionStableUserId: session.stableUserId,
			sessionIssuedAt: session.issuedAt,
		})),
		request,
		env,
	})
	if (!oidcGate.ok) {
		return {
			data: {
				ok: false,
				error: oidcGate.error,
				allowClientReset: false,
			},
			setCookie: null,
		}
	}

	const { authRequest, client } = resolution
	const clearResetVerificationCookie =
		requestHasOAuthClientResetVerificationCookie(request)
			? await destroyOAuthClientResetVerificationCookie(request, env)
			: null
	const resolvedScopes = resolveScopes(authRequest.scope)
	if (!Array.isArray(resolvedScopes)) {
		return {
			data: {
				ok: false,
				error: resolvedScopes.error,
				allowClientReset: false,
			},
			setCookie: clearResetVerificationCookie,
		}
	}
	const authorizeSession = await resolveAuthorizeSession(request, env)
	const sessionSetCookie = authorizeSession.setCookie
	const requireCredentials = oidcGate.treatAsSignedOut
	const sessionEmail = requireCredentials ? null : authorizeSession.email
	let emailVerified: boolean | null = null
	if (sessionEmail) {
		emailVerified = await isAccountEmailVerified({
			db: env.APP_DB,
			email: sessionEmail,
			stableUserId: authorizeSession.stableUserId ?? undefined,
		})
	}

	return {
		data: {
			ok: true,
			client: {
				id: client.clientId,
				name: client.clientName ?? client.clientId,
			},
			scopes: resolvedScopes,
			emailVerified,
			requireCredentials,
		},
		setCookie: clearResetVerificationCookie ?? sessionSetCookie,
	}
}

export async function handleAuthorizeInfo(
	request: Request,
	env: Env,
): Promise<Response> {
	const { data, setCookie } = await loadOAuthAuthorizeData(request, env)
	if (!data.ok) {
		return jsonResponse(
			{ ok: false, error: data.error, allowClientReset: data.allowClientReset },
			{
				status: 400,
				headers: createSetCookieHeaders([setCookie]),
			},
		)
	}

	return jsonResponse(
		{
			ok: true,
			client: data.client,
			scopes: data.scopes,
			emailVerified: data.emailVerified,
			requireCredentials: data.requireCredentials,
		},
		{
			headers: createSetCookieHeaders([setCookie]),
		},
	)
}

export function handleAuthorizeRouteException(
	request: Request,
): Promise<Response> | Response {
	const url = new URL(request.url)
	if (url.pathname === oauthPaths.authorizeInfo) {
		return jsonResponse(
			{
				ok: false,
				error: 'Unable to load authorization details.',
				allowClientReset: false,
			},
			{ status: 500 },
		)
	}

	const message =
		'OAuth authorization failed. Please start the connection again.'
	if (wantsJson(request)) {
		return jsonResponse(
			{ ok: false, error: message, code: 'server_error' },
			{ status: 500 },
		)
	}

	if (request.method === 'POST') {
		return createAuthorizeErrorRedirect(request, 'server_error', message)
	}

	return standaloneAuthorizeErrorHtmlResponse(message, 500)
}

async function tryHandleSilentOidcAuthorize(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const oidcParamsOrError = parseOidcAuthorizeParams(request)
	if (isOidcAuthorizeParamsParseError(oidcParamsOrError)) {
		return respondAuthorizeError(
			request,
			oidcParamsOrError.error,
			400,
			oidcParamsOrError.errorCode,
		)
	}
	const oidcParams = oidcParamsOrError
	const prompts = oidcParams.prompt?.split(/\s+/).filter(Boolean) ?? []
	if (!prompts.includes('none')) return null

	const helpers = getOAuthHelpers(env)
	const resolution = await resolveAuthRequest(helpers, request, env)
	if ('error' in resolution) {
		return respondAuthorizeError(
			request,
			resolution.error ?? 'Unable to process OAuth request.',
		)
	}

	const { authRequest } = resolution
	const authorizeSession = await resolveAuthorizeSession(request, env)
	const oidcGate = await evaluateOidcAuthorizeGate({
		params: oidcParams,
		session: {
			sessionEmail: authorizeSession.email,
			sessionStableUserId: authorizeSession.stableUserId,
			sessionIssuedAt: authorizeSession.issuedAt,
		},
		request,
		env,
	})
	if (!oidcGate.ok) {
		const redirectTo = createOidcClientErrorRedirectUrl(
			authRequest,
			oidcGate.errorCode,
			oidcGate.error,
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(
			request,
			oidcGate.error,
			oidcGate.status ?? 400,
			oidcGate.errorCode,
		)
	}
	if (!oidcGate.silentAuthorize) return null

	const pkceError = getPkceValidationError({
		codeChallenge: authRequest.codeChallenge,
		codeChallengeMethod: authRequest.codeChallengeMethod,
	})
	if (pkceError) {
		const redirectTo = createOidcClientErrorRedirectUrl(
			authRequest,
			'invalid_request',
			pkceError,
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(request, pkceError)
	}

	if (!authorizeSession.email || !authorizeSession.stableUserId) {
		const redirectTo = createOidcClientErrorRedirectUrl(
			authRequest,
			'login_required',
			'Login required.',
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(
			request,
			'Login required.',
			401,
			'login_required',
		)
	}

	const db = createDb(env.APP_DB)
	const userRecord = await db.findOne(usersTable, {
		where: { stable_user_id: authorizeSession.stableUserId },
	})
	if (!userRecord) {
		const redirectTo = createOidcClientErrorRedirectUrl(
			authRequest,
			'login_required',
			'Signed-in user not found.',
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(request, 'Signed-in user not found.', 401)
	}
	const username = getValidOAuthUsername(userRecord.username)
	if (!username) {
		const redirectTo = createOidcClientErrorRedirectUrl(
			authRequest,
			'interaction_required',
			'Username is required.',
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(request, 'Username is required.', 401)
	}

	const approvedEmail = userRecord.email.trim().toLowerCase()
	const approvedUserId = resolveUserStableId(userRecord)
	const emailVerified = await isAccountEmailVerified({
		db: env.APP_DB,
		email: approvedEmail,
		stableUserId: approvedUserId,
	})
	if (!emailVerified) {
		const redirectTo = createOidcClientErrorRedirectUrl(
			authRequest,
			'interaction_required',
			oauthEmailVerificationRequiredMessage,
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(
			request,
			oauthEmailVerificationRequiredMessage,
			403,
			'email_verification_required',
		)
	}

	const resolvedScopes = resolveScopes(authRequest.scope)
	if (!Array.isArray(resolvedScopes)) {
		const redirectTo = createOidcClientErrorRedirectUrl(
			authRequest,
			'invalid_scope',
			resolvedScopes.error,
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(request, resolvedScopes.error)
	}

	const existingGrants = await listUserOAuthGrantsForClient(
		helpers,
		approvedUserId,
		authRequest.clientId,
	)
	const hasMatchingConsent = existingGrants.some((grant) =>
		resolvedScopes.every((scope) => grant.scope.includes(scope)),
	)
	if (!hasMatchingConsent) {
		const redirectTo = createOidcClientErrorRedirectUrl(
			authRequest,
			'consent_required',
			'Consent is required for this client.',
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(
			request,
			'Consent is required for this client.',
			401,
			'consent_required',
		)
	}

	const authTime = authorizeSession.issuedAt
		? Math.floor(authorizeSession.issuedAt / 1000)
		: Math.floor(Date.now() / 1000)
	const { redirectTo } = await helpers.completeAuthorization({
		request: authRequest,
		userId: approvedUserId,
		metadata: {
			email: approvedEmail,
			clientId: authRequest.clientId,
		},
		scope: resolvedScopes,
		props: {
			userId: approvedUserId,
			email: approvedEmail,
			username,
			displayName: username,
			authTime,
			...(oidcParams.nonce ? { nonce: oidcParams.nonce } : {}),
		},
	})
	void logAuditEvent({
		category: 'oauth',
		action: 'authorize',
		result: 'success',
		email: approvedEmail,
		ip: getRequestIp(request) ?? undefined,
		clientId: authRequest.clientId,
	})
	return Response.redirect(redirectTo, 302)
}

export async function handleAuthorizeRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method === 'GET') {
		const silentOrError = await tryHandleSilentOidcAuthorize(request, env)
		if (silentOrError) return silentOrError
		const { data, setCookie } = await loadOAuthAuthorizeData(request, env)
		return renderSpaShell(request, env, {
			loaderData: { oauthAuthorize: data },
			setCookie,
		})
	}

	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 })
	}

	const requestIp = getRequestIp(request) ?? undefined
	const helpers = getOAuthHelpers(env)
	const oidcParamsOrError = parseOidcAuthorizeParams(request)
	if (isOidcAuthorizeParamsParseError(oidcParamsOrError)) {
		return respondAuthorizeError(
			request,
			oidcParamsOrError.error,
			400,
			oidcParamsOrError.errorCode,
		)
	}
	const oidcParams = oidcParamsOrError
	const oidcGate = await evaluateOidcAuthorizeGate({
		params: oidcParams,
		session: await resolveAuthorizeSession(request, env).then((session) => ({
			sessionEmail: session.email,
			sessionStableUserId: session.stableUserId,
			sessionIssuedAt: session.issuedAt,
		})),
		request,
		env,
	})
	if (!oidcGate.ok) {
		return respondAuthorizeError(
			request,
			oidcGate.error,
			oidcGate.status ?? 400,
			oidcGate.errorCode,
		)
	}

	const formData = await request.formData().catch(() => null)
	if (!formData) {
		return respondAuthorizeError(request, 'Invalid form data')
	}
	const decision = String(formData.get('decision') ?? 'approve')
	if (decision === 'reset-client') {
		return handleResetClientRequest(request, env, helpers, requestIp)
	}

	const resolution = await resolveAuthRequest(helpers, request, env)
	if ('error' in resolution) {
		return respondAuthorizeError(
			request,
			resolution.error ?? 'Unable to process OAuth request.',
		)
	}

	const { authRequest } = resolution
	// Reading the fields off the typed `AuthRequest` (rather than passing the
	// whole object) makes provider field renames a compile-time error here.
	const pkceError = getPkceValidationError({
		codeChallenge: authRequest.codeChallenge,
		codeChallengeMethod: authRequest.codeChallengeMethod,
	})
	if (pkceError) {
		void logAuditEvent({
			category: 'oauth',
			action: 'authorize',
			result: 'failure',
			ip: requestIp,
			clientId: authRequest.clientId,
			reason: 'invalid_pkce_method',
		})
		return respondAuthorizeError(request, pkceError)
	}

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
	const authorizeSession = await resolveAuthorizeSession(request, env)
	let setCookie = authorizeSession.setCookie
	const sessionEmail = oidcGate.treatAsSignedOut ? null : authorizeSession.email
	const session = oidcGate.treatAsSignedOut ? null : authorizeSession.session
	const hasFormCredentials = Boolean(email && password)
	const hasSession = Boolean(sessionEmail)

	if (oidcGate.forbidInlineLogin && hasFormCredentials) {
		return respondAuthorizeError(
			request,
			'Interactive login is not allowed for this authorization request.',
			400,
			'interaction_required',
		)
	}

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
	let approvedUsername = ''
	let approvedUserId = ''
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
		try {
			await upgradePasswordHashIfNeeded(
				db,
				userRecord.id,
				password,
				userRecord.password_hash,
			)
		} catch {
			// A failed hash upgrade must never block an otherwise valid login.
		}
		const username = getValidOAuthUsername(userRecord.username)
		if (!username) {
			void logAuditEvent({
				category: 'oauth',
				action: 'authorize',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				clientId: authRequest.clientId,
				reason: 'username_missing',
			})
			return respondAuthorizeError(request, 'Username is required.', 401)
		}
		// The inline OAuth password form has no TOTP step, so 2FA accounts must
		// establish a browser session (which enforces the second factor) first.
		if (await isTwoFactorEnabled(env.APP_DB, userRecord.id)) {
			void logAuditEvent({
				category: 'oauth',
				action: 'authorize',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				clientId: authRequest.clientId,
				reason: 'two_factor_required',
			})
			return respondAuthorizeError(
				request,
				'Two-factor authentication is enabled for this account. Log in on this device first, then retry connecting.',
				401,
			)
		}
		approvedEmail = normalizedEmail
		approvedUsername = username
		approvedUserId = resolveUserStableId(userRecord)
	} else if (sessionEmail) {
		const db = createDb(env.APP_DB)
		const userRecord = session?.stableUserId
			? await db.findOne(usersTable, {
					where: { stable_user_id: session.stableUserId },
				})
			: await db.findOne(usersTable, { where: { email: sessionEmail } })
		if (!userRecord) {
			void logAuditEvent({
				category: 'oauth',
				action: 'authorize',
				result: 'failure',
				email: sessionEmail,
				ip: requestIp,
				clientId: authRequest.clientId,
				reason: 'session_user_not_found',
			})
			return respondAuthorizeError(request, 'Signed-in user not found.', 401)
		}
		const username = getValidOAuthUsername(userRecord.username)
		if (!username) {
			void logAuditEvent({
				category: 'oauth',
				action: 'authorize',
				result: 'failure',
				email: sessionEmail,
				ip: requestIp,
				clientId: authRequest.clientId,
				reason: 'username_missing',
			})
			return respondAuthorizeError(request, 'Username is required.', 401)
		}
		approvedEmail = userRecord.email.trim().toLowerCase()
		approvedUsername = username
		approvedUserId = resolveUserStableId(userRecord)
		if (session && approvedEmail !== sessionEmail) {
			setCookie = await createAuthCookie(
				{
					stableUserId: session.stableUserId,
					email: approvedEmail,
					rememberMe: session.rememberMe,
				},
				isSecureRequest(request),
			)
		}
	}

	const emailVerified = await isAccountEmailVerified({
		db: env.APP_DB,
		email: approvedEmail,
		stableUserId: approvedUserId,
	})
	if (!emailVerified) {
		void logAuditEvent({
			category: 'oauth',
			action: 'authorize',
			result: 'failure',
			email: approvedEmail,
			ip: requestIp,
			clientId: authRequest.clientId,
			reason: 'email_verification_required',
		})
		return respondAuthorizeError(
			request,
			oauthEmailVerificationRequiredMessage,
			403,
			'email_verification_required',
			createSetCookieHeaders([setCookie]),
		)
	}

	const resolvedScopes = resolveScopes(authRequest.scope)
	if (Array.isArray(resolvedScopes)) {
		const userId = approvedUserId
		const displayName = approvedUsername
		const authTime = hasFormCredentials
			? Math.floor(Date.now() / 1000)
			: authorizeSession.issuedAt
				? Math.floor(authorizeSession.issuedAt / 1000)
				: Math.floor(Date.now() / 1000)
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
				username: approvedUsername,
				displayName,
				authTime,
				...(oidcParams.nonce ? { nonce: oidcParams.nonce } : {}),
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

export function handleOAuthCallback(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url)
	const hasError =
		url.searchParams.has('error') || url.searchParams.has('error_description')
	return renderSpaShell(request, env, { status: hasError ? 400 : 200 })
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
