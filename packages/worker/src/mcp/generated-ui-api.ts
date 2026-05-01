import { createRouter, type BuildAction } from 'remix/fetch-router'
import { post, route } from 'remix/fetch-router/routes'
import { z } from 'zod'
import { exports as workerExports } from 'cloudflare:workers'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	formatExecutionOutput,
	getExecutionErrorDetails,
} from '#mcp/executor.ts'
import {
	createGeneratedUiAppSession,
	verifyGeneratedUiAppSession,
} from '#mcp/generated-ui-app-session.ts'
import { runCodemodeWithRegistry } from '#mcp/run-codemode-registry.ts'
import { deleteSecret, listSecrets, saveSecret } from '#mcp/secrets/service.ts'
import { secretScopeValues } from '#mcp/secrets/types.ts'

const executeRequestSchema = z.object({
	code: z.string().min(1),
	params: z.record(z.string(), z.unknown()).optional(),
})

const secretMutationSchema = z.object({
	name: z.string().min(1),
	value: z.string().min(1),
	description: z.string().optional(),
	scope: z.enum(secretScopeValues).optional(),
})

const secretDeleteSchema = z.object({
	name: z.string().min(1),
	scope: z.enum(secretScopeValues).optional(),
})

const generatedUiApiRoutes = route({
	source: '/ui-api/:id',
	sourceWithSuffix: '/ui-api/:id/source',
	execute: post('/ui-api/:id/execute'),
	listSecrets: '/ui-api/:id/secrets',
	deleteSecret: post('/ui-api/:id/secrets/delete'),
})

type GeneratedUiSessionContext = {
	type: 'session'
	sessionId: string
	appId: string | null
	params: Record<string, unknown>
	homeConnectorId: string | null
	expiresAt: string
	user: {
		userId: string
		email: string
		displayName: string
	}
}

type GeneratedUiRequestContext = GeneratedUiSessionContext

export function isGeneratedUiApiRequest(pathname: string) {
	return pathname.startsWith('/ui-api/')
}

export async function handleGeneratedUiApiRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204 })
	}
	return createGeneratedUiApiRouter(env).fetch(request)
}

function createGeneratedUiApiRouter(env: Env) {
	const router = createRouter({
		middleware: [],
		async defaultHandler() {
			return jsonResponse({ error: 'Not found.' }, 404)
		},
	})

	const sourceHandler = createGeneratedUiSourceHandler(env)
	router.map(generatedUiApiRoutes, {
		actions: {
			source: sourceHandler,
			sourceWithSuffix: sourceHandler,
			execute: createGeneratedUiExecuteHandler(env),
			listSecrets: createGeneratedUiSecretsHandler(env),
			deleteSecret: createGeneratedUiDeleteSecretHandler(env),
		},
	})

	return router
}

function createGeneratedUiSourceHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const routeId = getGeneratedUiRouteId(params)
			if (!routeId) {
				return jsonResponse({ error: 'Not found.' }, 404)
			}
			const sourceContext = await resolveSourceContext({
				request,
				env,
				routeId,
				bearerToken: readBearerToken(request),
			})
			if (sourceContext instanceof Response) return sourceContext
			const appSession = await createGeneratedUiAppSession({
				env,
				baseUrl: getAppBaseUrl({ env, requestUrl: request.url }),
				user: sourceContext.user,
				appId: sourceContext.appId,
				params: sourceContext.params,
				homeConnectorId: sourceContext.homeConnectorId,
			})
			return jsonResponse({
				ok: true,
				appSession,
			})
		},
	} satisfies BuildAction<
		typeof generatedUiApiRoutes.source.method,
		typeof generatedUiApiRoutes.source.pattern
	>
}

function createGeneratedUiExecuteHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const context = await requireGeneratedUiSessionContext({
				request,
				env,
				routeId: getGeneratedUiRouteId(params),
			})
			if (context instanceof Response) return context
			const body = executeRequestSchema.safeParse(
				await request.json().catch(() => null),
			)
			if (!body.success) {
				return jsonResponse({ error: body.error.message }, 400)
			}
			const mergedParams =
				body.data.params == null
					? context.params
					: {
							...context.params,
							...body.data.params,
						}
			const result = await runCodemodeWithRegistry(
				env,
				createMcpCallerContext({
					baseUrl: getAppBaseUrl({ env, requestUrl: request.url }),
					user: context.user,
					homeConnectorId: context.homeConnectorId,
					storageContext: {
						sessionId: context.sessionId,
						appId: context.appId,
						storageId: context.sessionId,
					},
				}),
				body.data.code,
				Object.keys(mergedParams).length > 0 ? mergedParams : undefined,
				{
					executorExports: workerExports,
				},
			)
			if (result.error) {
				const errorDetails = getExecutionErrorDetails(result.error)
				return jsonResponse(
					{
						ok: false,
						error: formatExecutionOutput(result),
						errorDetails,
						logs: result.logs ?? [],
					},
					400,
				)
			}
			if (containsReturnedSecretPlaceholder(result.result)) {
				return jsonResponse(
					{
						ok: false,
						error:
							'Generated UI executeCode may not return unresolved `{{secret:...}}` placeholders. Secret placeholders only resolve inside secret-aware fetch requests or capability inputs that explicitly opt into `x-kody-secret`. Use persisted values for non-secret configuration, and call `kodyWidget.sendMessage(...)` (for example after `import { kodyWidget } from "@kody/ui-utils"`) when the user needs to intervene.',
						logs: result.logs ?? [],
					},
					400,
				)
			}
			return jsonResponse({
				ok: true,
				result: result.result ?? null,
				logs: result.logs ?? [],
			})
		},
	} satisfies BuildAction<
		typeof generatedUiApiRoutes.execute.method,
		typeof generatedUiApiRoutes.execute.pattern
	>
}

function createGeneratedUiSecretsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const context = await requireGeneratedUiSessionContext({
				request,
				env,
				routeId: getGeneratedUiRouteId(params),
			})
			if (context instanceof Response) return context
			if (request.method === 'GET') {
				const url = new URL(request.url)
				const scope = parseOptionalScope(url.searchParams.get('scope'))
				if (url.searchParams.has('scope') && scope == null) {
					return jsonResponse({ error: 'Invalid secret scope.' }, 400)
				}
				const secrets = await listSecrets({
					env,
					userId: context.user.userId,
					scope,
					storageContext: {
						sessionId: context.sessionId,
						appId: context.appId,
						storageId: context.sessionId,
					},
				})
				return jsonResponse({
					ok: true,
					secrets: secrets.map((secret) => ({
						name: secret.name,
						scope: secret.scope,
						description: secret.description,
						app_id: secret.appId,
						allowed_hosts: secret.allowedHosts,
						allowed_capabilities: secret.allowedCapabilities,
						created_at: secret.createdAt,
						updated_at: secret.updatedAt,
						ttl_ms: secret.ttlMs,
					})),
				})
			}

			if (request.method !== 'POST') {
				return jsonResponse({ error: 'Method not allowed.' }, 405)
			}

			const body = secretMutationSchema.safeParse(
				await request.json().catch(() => null),
			)
			if (!body.success) {
				return jsonResponse({ error: body.error.message }, 400)
			}
			try {
				const saved = await saveSecret({
					env,
					userId: context.user.userId,
					scope: body.data.scope ?? 'session',
					name: body.data.name,
					value: body.data.value,
					description: body.data.description ?? '',
					storageContext: {
						sessionId: context.sessionId,
						appId: context.appId,
						storageId: context.sessionId,
					},
					sessionExpiresAt: context.expiresAt,
				})
				return jsonResponse({
					ok: true,
					secret: {
						name: saved.name,
						scope: saved.scope,
						description: saved.description,
						app_id: saved.appId,
						allowed_hosts: saved.allowedHosts,
						allowed_capabilities: saved.allowedCapabilities,
						created_at: saved.createdAt,
						updated_at: saved.updatedAt,
						ttl_ms: saved.ttlMs,
					},
				})
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error ? error.message : 'Unable to save secret.',
					},
					400,
				)
			}
		},
	} satisfies BuildAction<
		typeof generatedUiApiRoutes.listSecrets.method,
		typeof generatedUiApiRoutes.listSecrets.pattern
	>
}

function createGeneratedUiDeleteSecretHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const context = await requireGeneratedUiSessionContext({
				request,
				env,
				routeId: getGeneratedUiRouteId(params),
			})
			if (context instanceof Response) return context
			const body = secretDeleteSchema.safeParse(
				await request.json().catch(() => null),
			)
			if (!body.success) {
				return jsonResponse({ error: body.error.message }, 400)
			}
			try {
				const deleted = await deleteSecret({
					env,
					userId: context.user.userId,
					name: body.data.name,
					scope: body.data.scope ?? 'session',
					storageContext: {
						sessionId: context.sessionId,
						appId: context.appId,
						storageId: context.sessionId,
					},
				})
				return jsonResponse({
					ok: true,
					deleted,
				})
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to delete secret.',
					},
					400,
				)
			}
		},
	} satisfies BuildAction<
		typeof generatedUiApiRoutes.deleteSecret.method,
		typeof generatedUiApiRoutes.deleteSecret.pattern
	>
}

async function resolveSourceContext(input: {
	request: Request
	env: Env
	routeId: string
	bearerToken: string | null
}): Promise<GeneratedUiRequestContext | Response> {
	if (!input.bearerToken) {
		return jsonResponse({ error: 'Missing generated UI bearer token.' }, 401)
	}
	return resolveSessionContext({
		env: input.env,
		routeId: input.routeId,
		token: input.bearerToken,
	})
}

async function requireGeneratedUiSessionContext(input: {
	request: Request
	env: Env
	routeId: string | null
}) {
	if (!input.routeId) {
		return jsonResponse({ error: 'Not found.' }, 404)
	}
	const bearerToken = readBearerToken(input.request)
	if (!bearerToken) {
		return jsonResponse({ error: 'Missing generated UI bearer token.' }, 401)
	}
	return resolveSessionContext({
		env: input.env,
		routeId: input.routeId,
		token: bearerToken,
	})
}

async function resolveSessionContext(input: {
	env: Env
	routeId: string
	token: string
}): Promise<GeneratedUiSessionContext | Response> {
	try {
		const session = await verifyGeneratedUiAppSession(input.env, input.token)
		if (session.session_id !== input.routeId) {
			return jsonResponse(
				{ error: 'Generated UI session does not match the requested UI.' },
				401,
			)
		}
		return {
			type: 'session',
			sessionId: session.session_id,
			appId: session.app_id,
			params:
				session.params &&
				typeof session.params === 'object' &&
				!Array.isArray(session.params)
					? session.params
					: {},
			homeConnectorId: session.home_connector_id,
			expiresAt:
				typeof session.exp === 'number'
					? new Date(session.exp).toISOString()
					: new Date().toISOString(),
			user: session.user,
		}
	} catch (error) {
		return jsonResponse(
			{
				error:
					error instanceof Error
						? error.message
						: 'Invalid generated UI bearer token.',
			},
			401,
		)
	}
}

function getGeneratedUiRouteId(params: Record<string, string | undefined>) {
	return params.id?.trim() || null
}

function readBearerToken(request: Request) {
	const authHeader = request.headers.get('Authorization')
	return authHeader?.startsWith('Bearer ')
		? authHeader.slice('Bearer '.length).trim()
		: null
}

function parseOptionalScope(value: string | null) {
	if (!value) return null
	return secretScopeValues.includes(value as (typeof secretScopeValues)[number])
		? (value as (typeof secretScopeValues)[number])
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

function containsReturnedSecretPlaceholder(value: unknown): boolean {
	if (typeof value === 'string') {
		return /\{\{secret:[a-zA-Z0-9._-]+/.test(value)
	}
	if (Array.isArray(value)) {
		return value.some((entry) => containsReturnedSecretPlaceholder(entry))
	}
	if (value && typeof value === 'object') {
		return Object.values(value).some((entry) =>
			containsReturnedSecretPlaceholder(entry),
		)
	}
	return false
}
