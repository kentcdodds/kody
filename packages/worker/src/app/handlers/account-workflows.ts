import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	loadAccountWorkflowsData,
	type AccountWorkflowsLoaderData,
} from '#app/account-workflows-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type AccountWorkflowsLoaderData as AppAccountWorkflowsLoaderData } from '#universal/loader-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { cancelWorkflowRunForUser } from '#worker/package-runtime/package-workflows.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

function readPathWorkflowId(params: unknown) {
	if (
		typeof params === 'object' &&
		params !== null &&
		'workflowId' in params &&
		typeof params.workflowId === 'string'
	) {
		return params.workflowId
	}
	return undefined
}

/**
 * Page handler for `/account/workflows` and `/account/workflows/:workflowId`.
 */
export function createAccountWorkflowsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountWorkflows = await loadAccountWorkflowsData({
				env,
				request,
				user,
				pathWorkflowId: readPathWorkflowId(params),
			})
			return renderAppPage({
				request,
				env,
				title: 'Workflows',
				loaderData: {
					accountWorkflows: accountWorkflows as AppAccountWorkflowsLoaderData,
				},
			})
		},
	} satisfies Action<
		typeof routes.accountWorkflows | typeof routes.accountWorkflowDetail
	>
}

/**
 * JSON API for `/account/workflows.json` (GET list/detail + POST cancel).
 */
export function createAccountWorkflowsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountWorkflowsData({
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
				if (action === 'cancel') {
					return await handleCancelAction({ env, user, body, request })
				}
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to update workflow run.',
					},
					400,
				)
			}

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<
		typeof routes.accountWorkflowsApi | typeof routes.accountWorkflowsApiPost
	>
}

async function reloadWorkflowsPayload(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	selectedWorkflowId?: string | null
}): Promise<AccountWorkflowsLoaderData> {
	const requestUrl = new URL(input.request.url)
	if (input.selectedWorkflowId) {
		requestUrl.searchParams.set('selected', input.selectedWorkflowId)
	} else {
		requestUrl.searchParams.delete('selected')
	}
	return await loadAccountWorkflowsData({
		env: input.env,
		request: new Request(requestUrl.toString(), {
			method: 'GET',
			headers: { Accept: 'application/json' },
		}),
		user: input.user,
	})
}

async function handleCancelAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	request: Request
}) {
	const id = readTrimmedStringOrEmpty(input.body, 'id')
	if (!id) {
		throw new Error('Workflow run id is required.')
	}

	const result = await cancelWorkflowRunForUser({
		env: input.env,
		userId: input.user.mcpUser.userId,
		workflowRunId: id,
	})

	switch (result.outcome) {
		case 'not_found':
			throw new Error(
				`Workflow run "${id}" was not found for the current user.`,
			)
		case 'already_terminal':
		case 'cancelled': {
			const payload = await reloadWorkflowsPayload({
				...input,
				selectedWorkflowId: id,
			})
			return jsonResponse({
				...payload,
				cancel: {
					cancelled: result.outcome === 'cancelled',
					alreadyTerminal: result.outcome === 'already_terminal',
					status: result.run.status,
				},
			})
		}
		default: {
			const exhaustive: never = result
			throw new Error(
				`Unhandled cancelWorkflowRunForUser outcome: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}
