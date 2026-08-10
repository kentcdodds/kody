import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	type AccountMemoriesLoaderData,
	loadAccountMemoriesData,
} from '#app/account-memories-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { deleteMemory } from '#mcp/memory/service.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

/**
 * Page + API handlers for `/account/memories`.
 */
export function createAccountMemoriesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountMemories = await loadAccountMemoriesData({
				env,
				request,
				user,
				pathMemoryId: readPathMemoryId(params),
			})
			return renderAppPage({
				request,
				env,
				title: 'Memories',
				loaderData: { accountMemories },
			})
		},
	} satisfies Action<
		typeof routes.accountMemories | typeof routes.accountMemoryDetail
	>
}

export function createAccountMemoriesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountMemoriesData({
						env,
						request,
						user,
					}),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const action = readTrimmedStringOrEmpty(body, 'action')
			try {
				if (action === 'delete') {
					return await handleDeleteAction({
						env,
						user,
						body,
						request,
					})
				}
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to update memories.',
					},
					400,
				)
			}

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<typeof routes.accountMemoriesApi>
}

async function handleDeleteAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	request: Request
}) {
	const memoryId = readTrimmedStringOrEmpty(input.body, 'memoryId')
	if (!memoryId) {
		return jsonResponse({ ok: false, error: 'Memory id is required.' }, 400)
	}
	const force = readBoolean(input.body, 'force', false)
	const deleted = await deleteMemory({
		env: input.env,
		userId: input.user.mcpUser.userId,
		memoryId,
		force,
	})
	if (!deleted) {
		return jsonResponse({ ok: false, error: 'Memory not found.' }, 404)
	}
	const payload: AccountMemoriesLoaderData = await loadAccountMemoriesData({
		env: input.env,
		request: input.request,
		user: input.user,
	})
	return jsonResponse(payload)
}

function readPathMemoryId(params: unknown) {
	if (
		typeof params === 'object' &&
		params !== null &&
		'memoryId' in params &&
		typeof params.memoryId === 'string'
	) {
		return params.memoryId
	}
	return undefined
}

function readBoolean(body: object, key: string, defaultValue: boolean) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'boolean' ? value : defaultValue
}
