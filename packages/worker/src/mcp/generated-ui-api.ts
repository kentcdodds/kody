import { z } from 'zod'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { storeDraftSecrets } from '#mcp/connections/connection-service.ts'
import { formatExecutionOutput } from '#mcp/executor.ts'
import { verifyGeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'
import { runCodemodeWithRegistry } from '#mcp/run-codemode-registry.ts'
import { getUiArtifactById, getUiArtifactByOwnerIds } from '#mcp/ui-artifacts-repo.ts'

const executeRequestSchema = z.object({
	code: z.string().min(1),
	params: z.record(z.string(), z.unknown()).optional(),
})

const secureInputRequestSchema = z.object({
	setup_id: z.string().min(1),
	fields: z.record(z.string(), z.string().min(1)),
})

export function isGeneratedUiApiRequest(pathname: string) {
	return parseGeneratedUiApiPath(pathname) !== null
}

export async function handleGeneratedUiApiRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url)
	const route = parseGeneratedUiApiPath(url.pathname)
	if (!route) {
		return jsonResponse({ error: 'Not found.' }, 404)
	}
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204 })
	}
	const context = await resolveGeneratedUiApiContext(request, env, route.uiId)
	if (context instanceof Response) {
		return context
	}

	if (route.endpoint === 'source') {
		if (request.method !== 'GET') {
			return jsonResponse({ error: 'Method not allowed.' }, 405)
		}
		const app = await resolveUiArtifactForSourceRequest(url, env, context)
		if (app instanceof Response) {
			return app
		}
		return jsonResponse({
			ok: true,
			app: {
				app_id: app.id,
				title: app.title,
				description: app.description,
				runtime: app.runtime,
				code: app.code,
			},
		})
	}

	if (route.endpoint === 'execute') {
		if (request.method !== 'POST') {
			return jsonResponse({ error: 'Method not allowed.' }, 405)
		}
		const body = executeRequestSchema.safeParse(
			await request.json().catch(() => null),
		)
		if (!body.success) {
			return jsonResponse({ error: body.error.message }, 400)
		}
		const callerContext = createMcpCallerContext(
			buildCallerContextInput(request, env, context),
		)
		const execution = await runCodemodeWithRegistry(
			env,
			callerContext,
			body.data.code,
			body.data.params,
		)
		if (execution.error) {
			return jsonResponse(
				{
					ok: false,
					error: formatExecutionOutput(execution),
					logs: execution.logs ?? [],
				},
				400,
			)
		}
		return jsonResponse({
			ok: true,
			result: execution.result ?? null,
			logs: execution.logs ?? [],
		})
	}

	if (route.endpoint === 'secure-input') {
		if (request.method !== 'POST') {
			return jsonResponse({ error: 'Method not allowed.' }, 405)
		}
		const body = secureInputRequestSchema.safeParse(
			await request.json().catch(() => null),
		)
		if (!body.success) {
			return jsonResponse({ error: body.error.message }, 400)
		}
		try {
			const result = await storeDraftSecrets({
				env,
				userId: getContextUserId(context),
				draftId: body.data.setup_id,
				fields: body.data.fields,
			})
			return jsonResponse({
				ok: true,
				...result,
			})
		} catch (error) {
			console.error('Generated UI secure input failed.', error)
			return jsonResponse(
				{
					ok: false,
					error: 'Secure input failed.',
				},
				400,
			)
		}
	}

	return jsonResponse({ error: 'Not found.' }, 404)
}

type GeneratedUiApiContext =
	| {
			type: 'session'
			session: Awaited<ReturnType<typeof verifyGeneratedUiAppSession>>
	  }
	| {
			type: 'saved-ui'
			user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
			artifact: NonNullable<
				Awaited<ReturnType<typeof getUiArtifactByOwnerIds>>
			>
	  }

type GeneratedUiApiEndpoint = 'source' | 'execute' | 'secure-input'

function parseGeneratedUiApiPath(pathname: string): {
	uiId: string
	endpoint: GeneratedUiApiEndpoint
} | null {
	const match = /^\/ui-api\/([^/]+)\/(source|execute|secure-input)$/.exec(
		pathname,
	)
	if (!match) {
		return null
	}
	try {
		return {
			uiId: decodeURIComponent(match[1] ?? ''),
			endpoint: (match[2] ?? '') as GeneratedUiApiEndpoint,
		}
	} catch {
		return null
	}
}

async function resolveGeneratedUiApiContext(
	request: Request,
	env: Env,
	uiId: string,
): Promise<GeneratedUiApiContext | Response> {
	const authHeader = request.headers.get('Authorization')
	if (authHeader?.startsWith('Bearer ')) {
		const token = authHeader.slice('Bearer '.length).trim()
		if (!token) {
			return jsonResponse({ error: 'Missing generated UI bearer token.' }, 401)
		}
		try {
			const session = await verifyGeneratedUiAppSession(env, token)
			if (session.session_id !== uiId) {
				return jsonResponse(
					{ error: 'Generated UI session does not match the requested UI.' },
					401,
				)
			}
			return {
				type: 'session',
				session,
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

	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return jsonResponse({ error: 'Unauthorized' }, 401)
	}
	const artifact = await getUiArtifactByOwnerIds(
		env.APP_DB,
		user.artifactOwnerIds,
		uiId,
	)
	if (!artifact) {
		return jsonResponse({ error: 'Saved UI not found.' }, 404)
	}
	return {
		type: 'saved-ui',
		user,
		artifact,
	}
}

async function resolveUiArtifactForSourceRequest(
	url: URL,
	env: Env,
	context: GeneratedUiApiContext,
) {
	if (context.type === 'saved-ui') {
		return context.artifact
	}
	const appId = url.searchParams.get('app_id')?.trim()
	if (!appId) {
		return jsonResponse({ error: 'Missing app_id query parameter.' }, 400)
	}
	const app = await getUiArtifactById(env.APP_DB, context.session.user.userId, appId)
	if (!app) {
		return jsonResponse({ error: 'Saved app not found for this user.' }, 404)
	}
	return app
}

function buildCallerContextInput(
	request: Request,
	env: Env,
	context: GeneratedUiApiContext,
) {
	const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
	if (context.type === 'session') {
		return {
			baseUrl,
			user: context.session.user,
			homeConnectorId: 'default',
		}
	}
	return {
		baseUrl,
		user: {
			userId: context.artifact.user_id,
			email: context.user.email,
			displayName: context.user.displayName,
		},
		homeConnectorId: null,
	}
}

function getContextUserId(context: GeneratedUiApiContext) {
	return context.type === 'session'
		? context.session.user.userId
		: context.artifact.user_id
}

function jsonResponse(body: Record<string, unknown>, status: number = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}
