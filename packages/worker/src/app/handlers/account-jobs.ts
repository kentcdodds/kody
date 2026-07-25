import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	isPackageOwnedJobId,
	loadAccountJobsData,
	type AccountJobsLoaderData,
} from '#app/account-jobs-data.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type AccountJobsLoaderData as AppAccountJobsLoaderData } from '#app/loader-data.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { type routes } from '#app/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runJobNowViaManager } from '#worker/jobs/manager-client.ts'
import { deleteJob, updateJob } from '#worker/jobs/service.ts'
import { type JobSchedule, type JobUpdateInput } from '#worker/jobs/types.ts'

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
		async handler({ request, params }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountJobs = await loadAccountJobsData({
				env,
				request,
				user,
				pathJobId: readPathJobId(params),
			})
			return renderAppPage({
				request,
				env,
				title: 'Jobs',
				loaderData: {
					accountJobs: accountJobs as AppAccountJobsLoaderData,
				},
			})
		},
	} satisfies Action<typeof routes.accountJobs | typeof routes.accountJobDetail>
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
				return jsonResponse(
					await loadAccountJobsData({
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
				if (action === 'set_enabled') {
					return await handleSetEnabledAction({ env, user, body, request })
				}
				if (action === 'set_kill_switch') {
					return await handleSetKillSwitchAction({ env, user, body, request })
				}
				if (action === 'run_now') {
					return await handleRunNowAction({ env, user, body, request })
				}
				if (action === 'delete') {
					return await handleDeleteAction({ env, user, body, request })
				}
				if (action === 'update') {
					return await handleUpdateAction({ env, user, body, request })
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

function assertAdHocJob(jobId: string, mutation: string) {
	if (isPackageOwnedJobId(jobId)) {
		throw new Error(
			`Package-owned jobs cannot ${mutation} from the account UI. Change the package job declaration and republish the package.`,
		)
	}
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
		executionOrigin: 'interactive',
		user: input.user.mcpUser,
	})
}

async function handleSetEnabledAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	request: Request
}) {
	const id = requireJobId(input.body)
	assertAdHocJob(id, 'change enabled state')
	const enabled = readBoolean(input.body, 'enabled')
	if (enabled === null) {
		throw new Error('enabled must be a boolean.')
	}
	await updateJob({
		env: input.env,
		callerContext: buildCallerContext(input),
		body: { id, enabled },
	})
	return jsonResponse(
		await reloadJobsPayload({
			...input,
			selectedJobId: id,
		}),
	)
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
		userId: input.user.mcpUser.userId,
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

async function handleDeleteAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	request: Request
}) {
	const id = requireJobId(input.body)
	assertAdHocJob(id, 'be deleted')
	await deleteJob({
		env: input.env,
		userId: input.user.mcpUser.userId,
		jobId: id,
	})
	return jsonResponse(
		await reloadJobsPayload({
			...input,
			selectedJobId: null,
		}),
	)
}

async function handleUpdateAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	request: Request
}) {
	const id = requireJobId(input.body)
	assertAdHocJob(id, 'edit name, schedule, or timezone')

	const updateBody: JobUpdateInput = { id }
	const name = readOptionalTrimmedString(input.body, 'name')
	if (name !== undefined) {
		updateBody.name = name
	}
	const timezone = readOptionalNullableString(input.body, 'timezone')
	if (timezone !== undefined) {
		updateBody.timezone = timezone
	}
	const schedule = readOptionalSchedule(input.body)
	if (schedule !== undefined) {
		updateBody.schedule = schedule
	}

	if (
		updateBody.name === undefined &&
		updateBody.timezone === undefined &&
		updateBody.schedule === undefined
	) {
		throw new Error('Provide name, schedule, and/or timezone to update.')
	}

	await updateJob({
		env: input.env,
		callerContext: buildCallerContext(input),
		body: updateBody,
	})
	return jsonResponse(
		await reloadJobsPayload({
			...input,
			selectedJobId: id,
		}),
	)
}

function readBoolean(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'boolean' ? value : null
}

function readOptionalTrimmedString(body: object, key: string) {
	if (!(key in (body as Record<string, unknown>))) {
		return undefined
	}
	const value = readTrimmedStringOrEmpty(body, key)
	if (!value) {
		throw new Error(`${key} must be a non-empty string.`)
	}
	return value
}

function readOptionalNullableString(body: object, key: string) {
	if (!(key in (body as Record<string, unknown>))) {
		return undefined
	}
	const value = (body as Record<string, unknown>)[key]
	if (value === null) {
		return null
	}
	if (typeof value !== 'string') {
		throw new Error(`${key} must be a string or null.`)
	}
	const trimmed = value.trim()
	return trimmed || null
}

function readOptionalSchedule(body: object): JobSchedule | undefined {
	if (!('schedule' in (body as Record<string, unknown>))) {
		return undefined
	}
	const schedule = (body as Record<string, unknown>).schedule
	if (!schedule || typeof schedule !== 'object') {
		throw new Error('schedule must be an object.')
	}
	const type = readTrimmedStringOrEmpty(schedule, 'type')
	switch (type) {
		case 'once': {
			const runAt =
				readTrimmedStringOrEmpty(schedule, 'runAt') ||
				readTrimmedStringOrEmpty(schedule, 'run_at')
			if (!runAt) {
				throw new Error('once schedules require runAt.')
			}
			return { type: 'once', runAt }
		}
		case 'interval': {
			const every = readTrimmedStringOrEmpty(schedule, 'every')
			if (!every) {
				throw new Error('interval schedules require every.')
			}
			return { type: 'interval', every }
		}
		case 'cron': {
			const expression = readTrimmedStringOrEmpty(schedule, 'expression')
			if (!expression) {
				throw new Error('cron schedules require expression.')
			}
			return { type: 'cron', expression }
		}
		default:
			throw new Error('schedule.type must be once, interval, or cron.')
	}
}
