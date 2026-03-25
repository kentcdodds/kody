import { type BuildAction } from 'remix/fetch-router'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'
import { formatExecutionOutput } from '#mcp/executor.ts'
import { runCodemodeWithRegistry } from '#mcp/run-codemode-registry.ts'
import { getUiArtifactByOwnerIds } from '#mcp/ui-artifacts-repo.ts'

function jsonResponse(data: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(data), {
		...init,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			...init?.headers,
		},
	})
}

function parseKeywords(raw: string) {
	try {
		const value = JSON.parse(raw) as unknown
		if (!Array.isArray(value)) return []
		return value.filter((entry): entry is string => typeof entry === 'string')
	} catch {
		return []
	}
}

async function getSavedUiForRequest(
	request: Request,
	env: Env,
	artifactId: string,
) {
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) return { user: null, artifact: null }
	const artifact = await getUiArtifactByOwnerIds(
		env.APP_DB,
		user.artifactOwnerIds,
		artifactId,
	)
	return { user, artifact }
}

export function createSavedUiPageHandler(env: Env) {
	return {
		middleware: [],
		async action({ request, params }) {
			const appId = params.id?.trim()
			if (!appId) {
				return new Response('Saved UI not found.', { status: 404 })
			}

			const { user, artifact } = await getSavedUiForRequest(request, env, appId)
			if (!user) {
				return redirectToLogin(request)
			}
			if (!artifact) {
				return new Response('Saved UI not found.', { status: 404 })
			}

			return render(Layout({ title: artifact.title || 'Saved UI' }))
		},
	} satisfies BuildAction<typeof routes.savedUi.method, typeof routes.savedUi.pattern>
}

export function createSavedUiDataHandler(env: Env) {
	return {
		middleware: [],
		async action({ request, params }) {
			const appId = params.id?.trim()
			if (!appId) {
				return jsonResponse(
					{ ok: false, error: 'Saved UI not found.' },
					{ status: 404 },
				)
			}

			const { user, artifact } = await getSavedUiForRequest(request, env, appId)
			if (!user) {
				return jsonResponse(
					{ ok: false, error: 'Unauthorized' },
					{ status: 401 },
				)
			}
			if (!artifact) {
				return jsonResponse(
					{ ok: false, error: 'Saved UI not found.' },
					{ status: 404 },
				)
			}

			return jsonResponse({
				ok: true,
				artifact: {
					appId: artifact.id,
					title: artifact.title,
					description: artifact.description,
					keywords: parseKeywords(artifact.keywords),
					runtime: artifact.runtime,
					code: artifact.code,
					createdAt: artifact.created_at,
					updatedAt: artifact.updated_at,
				},
			})
		},
	} satisfies BuildAction<
		typeof routes.savedUiData.method,
		typeof routes.savedUiData.pattern
	>
}

export function createSavedUiExecuteHandler(env: Env) {
	return {
		middleware: [],
		async action({ request, params }) {
			const appId = params.id?.trim()
			if (!appId) {
				return jsonResponse(
					{ ok: false, error: 'Saved UI not found.' },
					{ status: 404 },
				)
			}

			const { user, artifact } = await getSavedUiForRequest(request, env, appId)
			if (!user) {
				return jsonResponse(
					{ ok: false, error: 'Unauthorized' },
					{ status: 401 },
				)
			}
			if (!artifact) {
				return jsonResponse(
					{ ok: false, error: 'Saved UI not found.' },
					{ status: 404 },
				)
			}

			let body: unknown
			try {
				body = await request.json()
			} catch {
				return jsonResponse(
					{ ok: false, error: 'Invalid JSON payload.' },
					{ status: 400 },
				)
			}

			const code =
				body &&
				typeof body === 'object' &&
				typeof (body as { code?: unknown }).code === 'string'
					? (body as { code: string }).code.trim()
					: ''
			if (!code) {
				return jsonResponse(
					{ ok: false, error: 'Code is required.' },
					{ status: 400 },
				)
			}

			const baseUrl = getAppBaseUrl({ env, requestUrl: request.url })
			const result = await runCodemodeWithRegistry(env, {
				baseUrl,
				user: {
					userId: artifact.user_id,
					email: user.email,
					displayName: user.displayName,
				},
				homeConnectorId: null,
			}, code)
			if (result.error) {
				return jsonResponse(
					{
						ok: false,
						error: formatExecutionOutput(result),
						logs: result.logs ?? [],
					},
					{ status: 400 },
				)
			}

			return jsonResponse({
				ok: true,
				result: result.result ?? null,
				logs: result.logs ?? [],
			})
		},
	} satisfies BuildAction<
		typeof routes.savedUiExecute.method,
		typeof routes.savedUiExecute.pattern
	>
}
