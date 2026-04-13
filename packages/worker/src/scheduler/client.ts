import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type ScheduledJobView,
	type SchedulerCreateInput,
	type SchedulerExecutionResult,
	type SchedulerUpdateInput,
} from './types.ts'

type SchedulerMutationRequest<TBody> = {
	callerContext: McpCallerContext
	body?: TBody
}

type SchedulerRunNowResponse = {
	job: ScheduledJobView
	execution: SchedulerExecutionResult
}

function getSchedulerStub(env: Env, userId: string) {
	return env.SCHEDULER_DO.get(env.SCHEDULER_DO.idFromName(userId))
}

async function schedulerJsonRequest<TResult>(
	stub: DurableObjectStub,
	input: {
		method: string
		pathname: string
		body?: unknown
	},
) {
	const response = await stub.fetch(
		`https://scheduler.internal${input.pathname}`,
		{
			method: input.method,
			headers: input.body
				? {
						'Content-Type': 'application/json',
					}
				: undefined,
			body: input.body === undefined ? undefined : JSON.stringify(input.body),
		},
	)
	if (!response.ok) {
		throw new Error(await response.text())
	}
	return (await response.json()) as TResult
}

export async function schedulerCreate(
	env: Env,
	userId: string,
	request: SchedulerMutationRequest<SchedulerCreateInput>,
) {
	return schedulerJsonRequest<ScheduledJobView>(getSchedulerStub(env, userId), {
		method: 'POST',
		pathname: '/jobs',
		body: request,
	})
}

export async function schedulerList(env: Env, userId: string) {
	return schedulerJsonRequest<Array<ScheduledJobView>>(
		getSchedulerStub(env, userId),
		{
			method: 'GET',
			pathname: '/jobs',
		},
	)
}

export async function schedulerGet(env: Env, userId: string, jobId: string) {
	return schedulerJsonRequest<ScheduledJobView>(getSchedulerStub(env, userId), {
		method: 'GET',
		pathname: `/jobs/${encodeURIComponent(jobId)}`,
	})
}

export async function schedulerUpdate(
	env: Env,
	userId: string,
	request: SchedulerMutationRequest<SchedulerUpdateInput>,
) {
	const id = request.body?.id
	if (!id) {
		throw new Error('Scheduler update requires a job id.')
	}
	return schedulerJsonRequest<ScheduledJobView>(getSchedulerStub(env, userId), {
		method: 'PATCH',
		pathname: `/jobs/${encodeURIComponent(id)}`,
		body: request,
	})
}

export async function schedulerDelete(env: Env, userId: string, jobId: string) {
	return schedulerJsonRequest<{ id: string; deleted: true }>(
		getSchedulerStub(env, userId),
		{
			method: 'DELETE',
			pathname: `/jobs/${encodeURIComponent(jobId)}`,
		},
	)
}

export async function schedulerRunNow(
	env: Env,
	userId: string,
	request: SchedulerMutationRequest<{ id: string }>,
) {
	const id = request.body?.id
	if (!id) {
		throw new Error('Scheduler run_now requires a job id.')
	}
	return schedulerJsonRequest<SchedulerRunNowResponse>(
		getSchedulerStub(env, userId),
		{
			method: 'POST',
			pathname: `/jobs/${encodeURIComponent(id)}/run-now`,
			body: request,
		},
	)
}
