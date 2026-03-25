import { z } from 'zod'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runCodemodeWithRegistry } from '#mcp/run-codemode-registry.ts'
import { verifyGeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'
import { storeDraftSecrets } from '#mcp/connections/connection-service.ts'

const actionRequestSchema = z.object({
	code: z.string().min(1),
	params: z.record(z.string(), z.unknown()).optional(),
})

const secureInputRequestSchema = z.object({
	setup_id: z.string().min(1),
	fields: z.record(z.string(), z.string().min(1)),
})

export function isGeneratedUiApiRequest(pathname: string) {
	return pathname.startsWith('/api/generated-ui/')
}

export async function handleGeneratedUiApiRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const session = await authenticateGeneratedUiSession(request, env)
	if (session instanceof Response) {
		return session
	}
	const url = new URL(request.url)

	if (url.pathname === '/api/generated-ui/app-source') {
		if (request.method !== 'GET') {
			return jsonResponse({ error: 'Method not allowed.' }, 405)
		}
		const appId = url.searchParams.get('app_id')
		if (!appId) {
			return jsonResponse({ error: 'Missing app_id query parameter.' }, 400)
		}
		const app = await getUiArtifactById(env.APP_DB, session.user.userId, appId)
		if (!app) {
			return jsonResponse({ error: 'Saved app not found for this user.' }, 404)
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

	if (url.pathname === '/api/generated-ui/actions') {
		if (request.method !== 'POST') {
			return jsonResponse({ error: 'Method not allowed.' }, 405)
		}
		const body = actionRequestSchema.safeParse(
			await request.json().catch(() => null),
		)
		if (!body.success) {
			return jsonResponse({ error: body.error.message }, 400)
		}
		const callerContext = createMcpCallerContext({
			baseUrl: url.origin,
			user: session.user,
		})
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
					error: String(execution.error),
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

	if (url.pathname === '/api/generated-ui/secure-input') {
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
				userId: session.user.userId,
				draftId: body.data.setup_id,
				fields: body.data.fields,
			})
			return jsonResponse({
				ok: true,
				...result,
			})
		} catch (error) {
			return jsonResponse(
				{
					ok: false,
					error:
						error instanceof Error
							? error.message
							: 'Secure input failed.',
				},
				400,
			)
		}
	}

	return jsonResponse({ error: 'Not found.' }, 404)
}

async function authenticateGeneratedUiSession(request: Request, env: Env) {
	const authHeader = request.headers.get('Authorization')
	if (!authHeader?.startsWith('Bearer ')) {
		return jsonResponse({ error: 'Missing generated UI bearer token.' }, 401)
	}
	const token = authHeader.slice('Bearer '.length).trim()
	if (!token) {
		return jsonResponse({ error: 'Missing generated UI bearer token.' }, 401)
	}
	try {
		return await verifyGeneratedUiAppSession(env, token)
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

function jsonResponse(body: Record<string, unknown>, status: number = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}
