import { type BuildAction } from 'remix/fetch-router'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'
import { buildAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import {
	createGeneratedUiAppSession,
	verifyGeneratedUiAppSession,
} from '#mcp/generated-ui-app-session.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { secretScopeValues, type SecretScope } from '#mcp/secrets/types.ts'
import { saveValue } from '#mcp/values/service.ts'

export function createConnectSecretHandler(_env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			const { session, setCookie } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}
			const response = render(Layout({ title: 'Connect secret' }))
			if (setCookie) {
				response.headers.set('Set-Cookie', setCookie)
			}
			return response
		},
	} satisfies BuildAction<
		typeof routes.connectSecret.method,
		typeof routes.connectSecret.pattern
	>
}

export function createConnectSecretApiHandler(env: Env) {
	return {
		middleware: [],
		async action({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const url = new URL(request.url)
				const scope = readSecretScope(url)
				const connector = readOptionalStringParam(url, 'connector')
				const name = readOptionalStringParam(url, 'name')
				const appId =
					scope === 'app'
						? buildConnectSecretAppId({ connector, name })
						: null
				const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
				const appSession = await createGeneratedUiAppSession({
					env,
					baseUrl,
					user: user.mcpUser,
					appId,
					homeConnectorId: null,
				})
				return jsonResponse({
					ok: true,
					appSession: {
						token: appSession.token,
						sessionId: appSession.sessionId,
						endpoints: appSession.endpoints,
					},
				})
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const name = readString(body, 'name')
			const scope = readScope(body)
			const sessionToken = readString(body, 'sessionToken')
			const connector = readOptionalString(body, 'connector')
			const requestedAllowedHosts =
				readOptionalStringArray(body, 'allowedHosts') ?? []
			if (!name) {
				return jsonResponse({ ok: false, error: 'Secret name is required.' }, 400)
			}
			if (!scope) {
				return jsonResponse({ ok: false, error: 'Secret scope is required.' }, 400)
			}
			if (!sessionToken) {
				return jsonResponse(
					{ ok: false, error: 'Session token is required.' },
					400,
				)
			}

			let session
			try {
				session = await verifyGeneratedUiAppSession(env, sessionToken)
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Invalid session token.',
					},
					401,
				)
			}
			if (session.user.userId !== user.mcpUser.userId) {
				return jsonResponse({ ok: false, error: 'User mismatch.' }, 403)
			}

			const storageContext = {
				sessionId: session.session_id,
				appId: session.app_id ?? null,
			}

			try {
				if (connector) {
					const resolved = await resolveSecret({
						env,
						userId: user.mcpUser.userId,
						name,
						scope,
						storageContext,
					})
					if (!resolved.found) {
						return jsonResponse({ ok: false, error: 'Secret not found.' }, 404)
					}
					const allowedHosts =
						requestedAllowedHosts.length > 0
							? normalizeAllowedHosts(requestedAllowedHosts)
							: resolved.allowedHosts
					await saveValue({
						env,
						userId: user.mcpUser.userId,
						name: `_connector:${connector}`,
						value: JSON.stringify({
							secretName: name,
							allowedHosts,
						}),
						description: `Connector secret config for ${connector}`,
						scope,
						storageContext,
					})
				}
				return jsonResponse({ ok: true })
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to update connector configuration.',
					},
					400,
				)
			}
		},
	} satisfies BuildAction<
		typeof routes.connectSecretApi.method,
		typeof routes.connectSecretApi.pattern
	>
}

function readSecretScope(url: URL): SecretScope {
	const raw = readOptionalStringParam(url, 'scope')
	return raw && secretScopeValues.includes(raw as SecretScope)
		? (raw as SecretScope)
		: 'user'
}

function readOptionalStringParam(url: URL, key: string) {
	const value = url.searchParams.get(key)
	return value?.trim() ? value.trim() : null
}

function readString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalStringArray(body: object, key: string) {
	if (!Object.hasOwn(body, key)) return null
	const value = (body as Record<string, unknown>)[key]
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === 'string')
}

function readScope(body: object): SecretScope | null {
	const raw = readString(body, 'scope')
	return raw && secretScopeValues.includes(raw as SecretScope)
		? (raw as SecretScope)
		: null
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}
