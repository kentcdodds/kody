import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	loadAccountJobsData,
	type AccountJobsLoaderData,
} from '#app/account-jobs-data.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type AccountJobsLoaderData as AppAccountJobsLoaderData } from '#universal/loader-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { type routes } from '#universal/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type ServerTimingEntry } from '#worker/server-timing.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runJobNowViaManager } from '#worker/jobs/manager-client.ts'
import { updateJob } from '#worker/jobs/service.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

function readPathJobId(params: unknown) {
	if (
		typeof params === 'object' &&
		params !== null &&
		'jobId' in params &&
		typeof params.jobId === 'string'
	) {
		return params.jobId
	}
	return undefined
}

/**
 * Page handler for `/account/jobs` and `/account/jobs/:jobId`.
 */
export function createAccountJobsHandler(env: Env) {
	return {
		middleware: [],
		async handler({
			request,
			params,
		}: {
			request: Request
			params?: { jobId?: string }
		}) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const serverTiming: Array<ServerTimingEntry> = []
			const accountJobs = await loadAccountJobsData({
				env,
				request,
				user,
				pathJobId: readPathJobId(params),
				serverTiming,
			})
			return renderAppPage({
				request,
				env,
				title: 'Jobs',
				loaderData: {
					accountJobs: accountJobs as AppAccountJobsLoaderData,
				},
				serverTiming,
			})
		},
	}
}

/**
 * JSON API for `/account/jobs.json` (GET list/detail + POST mutations).
 */
export function createAccountJobsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				const serverTiming: Array<ServerTimingEntry> = []
				return jsonResponse(
					await loadAccountJobsData({
						env,
						request,
						user,
						serverTiming,
					}),
					{ serverTiming },
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
				if (action === 'set_kill_switch') {
					return await handleSetKillSwitchAction({ env, user, body, request })
				}
				if (action === 'run_now') {
					return await handleRunNowAction({ env, user, body, request })
				}
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to update scheduled job.',
					},
					400,
				)
			}

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<typeof routes.accountJobsApi>
}

async function reloadJobsPayload(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	selectedJobId?: string | null
}): Promise<AccountJobsLoaderData> {
	const requestUrl = new URL(input.request.url)
	if (input.selectedJobId) {
		requestUrl.searchParams.set('selected', input.selectedJobId)
	} else {
		requestUrl.searchParams.delete('selected')
	}
	// Build a fresh GET-shaped Request so we do not reuse a consumed POST body.
	return await loadAccountJobsData({
		env: input.env,
		request: new Request(requestUrl.toString(), {
			method: 'GET',
			headers: { Accept: 'application/json' },
		}),
		user: input.user,
	})
}

function requireJobId(body: object) {
	const id = readTrimmedStringOrEmpty(body, 'id')
	if (!id) {
		throw new Error('Job id is required.')
	}
	return id
}

function buildCallerContext(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
}) {
	return createMcpCallerContext({
		baseUrl: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
		source: { kind: 'session' },
		executionOrigin: 'interactive',
		user: input.user.mcpUser,
		orgBinding: {
			org: input.user.request.org,
			role: input.user.request.membership?.role ?? null,
		},
	})
}

async function handleSetKillSwitchAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	request: Request
}) {
	const id = requireJobId(input.body)
	const killSwitchEnabled = readBoolean(input.body, 'killSwitchEnabled')
	if (killSwitchEnabled === null) {
		throw new Error('killSwitchEnabled must be a boolean.')
	}
	await updateJob({
		env: input.env,
		callerContext: buildCallerContext(input),
		body: { id, killSwitchEnabled },
	})
	return jsonResponse(
		await reloadJobsPayload({
			...input,
			selectedJobId: id,
		}),
	)
}

async function handleRunNowAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	request: Request
}) {
	const id = requireJobId(input.body)
	const result = await runJobNowViaManager({
		env: input.env,
		userId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		jobId: id,
		callerContext: buildCallerContext(input),
	})
	const payload = await reloadJobsPayload({
		...input,
		selectedJobId: result.deletedAfterRun ? null : id,
	})
	return jsonResponse({
		...payload,
		runNow: {
			ok: result.execution.ok,
			error: result.execution.ok ? null : result.execution.error,
			deletedAfterRun: result.deletedAfterRun,
		},
	})
}

function readBoolean(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'boolean' ? value : null
}
