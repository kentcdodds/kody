import * as Sentry from '@sentry/cloudflare'
import { DurableObject, exports as workerExports } from 'cloudflare:workers'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { buildSentryOptions } from '#worker/sentry-options.ts'
import { createMcpCallerContext, parseMcpCallerContext } from '#mcp/context.ts'
import { runCodemodeWithRegistry } from '#mcp/run-codemode-registry.ts'
import { processDueJobs } from './process-due-jobs.ts'
import {
	computeNextRunAt,
	formatSchedulerError,
	isJobDue,
	normalizeScheduledJobSchedule,
	normalizeSchedulerTimezone,
	toScheduledJobView,
} from './schedule.ts'
import {
	type PersistedSchedulerCallerContext,
	type ScheduledJob,
	type SchedulerCreateInput,
	type SchedulerExecutionResult,
	type SchedulerUpdateInput,
} from './types.ts'

const callerContextStorageKey = 'scheduler:caller-context'
const jobStorageKeyPrefix = 'job:'

function getJobStorageKey(jobId: string) {
	return `${jobStorageKeyPrefix}${jobId}`
}

function requirePersistableSchedulerCallerContext(
	callerContext: McpCallerContext,
): PersistedSchedulerCallerContext {
	if (!callerContext.user) {
		throw new Error(
			'Authenticated MCP user is required for scheduler operations.',
		)
	}
	return createMcpCallerContext({
		baseUrl: callerContext.baseUrl,
		user: callerContext.user,
		homeConnectorId: callerContext.homeConnectorId ?? null,
		remoteConnectors: callerContext.remoteConnectors ?? null,
		storageContext: callerContext.storageContext ?? null,
	}) as PersistedSchedulerCallerContext
}

function normalizeJobName(name: string) {
	const trimmed = name.trim()
	if (!trimmed) {
		throw new Error('Scheduled jobs require a non-empty name.')
	}
	return trimmed
}

function normalizeJobCode(code: string) {
	if (!code.trim()) {
		throw new Error('Scheduled jobs require non-empty code.')
	}
	return code
}

function normalizeOptionalParams(
	params: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
	return params === null || params === undefined ? undefined : params
}

class SchedulerDOBase extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		try {
			const url = new URL(request.url)
			const segments = url.pathname.split('/').filter(Boolean)
			if (segments.length === 1 && segments[0] === 'jobs') {
				if (request.method === 'GET') {
					return Response.json(await this.handleListJobs())
				}
				if (request.method === 'POST') {
					return Response.json(await this.handleCreateJob(request))
				}
			}
			if (segments.length === 2 && segments[0] === 'jobs') {
				const jobId = decodeURIComponent(segments[1] ?? '')
				if (request.method === 'GET') {
					return Response.json(await this.handleGetJob(jobId))
				}
				if (request.method === 'PATCH') {
					return Response.json(await this.handleUpdateJob(jobId, request))
				}
				if (request.method === 'DELETE') {
					return Response.json(await this.handleDeleteJob(jobId))
				}
			}
			if (
				segments.length === 3 &&
				segments[0] === 'jobs' &&
				segments[2] === 'run-now' &&
				request.method === 'POST'
			) {
				return Response.json(
					await this.handleRunNow(
						decodeURIComponent(segments[1] ?? ''),
						request,
					),
				)
			}
			return new Response('Not found', { status: 404 })
		} catch (error) {
			return new Response(formatSchedulerError(error), { status: 400 })
		}
	}

	async alarm(): Promise<void> {
		const now = new Date()
		const dueJobs = (await this.listStoredJobs()).filter((job) =>
			isJobDue(job, now),
		)
		if (dueJobs.length === 0) {
			await this.syncAlarm()
			return
		}
		const callerContext = await this.getPersistedCallerContext()
		const result = await processDueJobs({
			jobs: dueJobs,
			now,
			executeJob: async (job) => this.executeJob(job, callerContext),
		})
		for (const job of result.saveJobs) {
			await this.ctx.storage.put(getJobStorageKey(job.id), job)
		}
		for (const jobId of result.deleteJobIds) {
			await this.ctx.storage.delete(getJobStorageKey(jobId))
		}
		await this.syncAlarm()
	}

	private async handleCreateJob(request: Request) {
		const payload =
			await this.parseMutationRequest<SchedulerCreateInput>(request)
		await this.persistCallerContext(payload.callerContext)
		const timezone = normalizeSchedulerTimezone(payload.body.timezone)
		const schedule = normalizeScheduledJobSchedule(payload.body.schedule)
		const now = new Date().toISOString()
		const job: ScheduledJob = {
			id: crypto.randomUUID(),
			name: normalizeJobName(payload.body.name),
			code: normalizeJobCode(payload.body.code),
			params: normalizeOptionalParams(payload.body.params),
			schedule,
			timezone,
			enabled: payload.body.enabled ?? true,
			createdAt: now,
			nextRunAt: computeNextRunAt({
				schedule,
				timezone,
			}),
		}
		await this.ctx.storage.put(getJobStorageKey(job.id), job)
		await this.syncAlarm()
		return toScheduledJobView(job)
	}

	private async handleListJobs() {
		return (await this.listStoredJobs()).map((job) => toScheduledJobView(job))
	}

	private async handleGetJob(jobId: string) {
		const job = await this.requireStoredJob(jobId)
		return toScheduledJobView(job)
	}

	private async handleUpdateJob(jobId: string, request: Request) {
		const payload =
			await this.parseMutationRequest<SchedulerUpdateInput>(request)
		if (payload.body.id && payload.body.id !== jobId) {
			throw new Error(
				'Scheduler job id in the body must match the request path.',
			)
		}
		await this.persistCallerContext(payload.callerContext)
		const existing = await this.requireStoredJob(jobId)
		const hasScheduleUpdate = payload.body.schedule !== undefined
		const hasTimezoneUpdate = payload.body.timezone !== undefined
		const schedule = hasScheduleUpdate
			? normalizeScheduledJobSchedule(payload.body.schedule)
			: existing.schedule
		const timezone =
			payload.body.timezone === null
				? normalizeSchedulerTimezone(null)
				: normalizeSchedulerTimezone(payload.body.timezone ?? existing.timezone)
		const nextRunAt =
			hasScheduleUpdate || hasTimezoneUpdate
				? computeNextRunAt({
						schedule,
						timezone,
					})
				: existing.nextRunAt
		const updated: ScheduledJob = {
			...existing,
			name:
				payload.body.name === undefined
					? existing.name
					: normalizeJobName(payload.body.name),
			code:
				payload.body.code === undefined
					? existing.code
					: normalizeJobCode(payload.body.code),
			params:
				payload.body.params === undefined
					? existing.params
					: normalizeOptionalParams(payload.body.params),
			schedule,
			timezone,
			enabled: payload.body.enabled ?? existing.enabled,
			nextRunAt,
		}
		await this.ctx.storage.put(getJobStorageKey(jobId), updated)
		await this.syncAlarm()
		return toScheduledJobView(updated)
	}

	private async handleDeleteJob(jobId: string) {
		await this.requireStoredJob(jobId)
		await this.ctx.storage.delete(getJobStorageKey(jobId))
		await this.syncAlarm()
		return {
			id: jobId,
			deleted: true as const,
		}
	}

	private async handleRunNow(jobId: string, request: Request) {
		const payload = await this.parseMutationRequest<{ id?: string }>(request)
		if (payload.body.id && payload.body.id !== jobId) {
			throw new Error(
				'Scheduler job id in the body must match the request path.',
			)
		}
		await this.persistCallerContext(payload.callerContext)
		const existing = await this.requireStoredJob(jobId)
		const execution = await this.executeJob(existing, payload.callerContext)
		const updated: ScheduledJob = {
			...existing,
			lastRunAt: new Date().toISOString(),
			lastRunStatus: execution.ok ? 'success' : 'error',
			lastRunError: execution.ok ? undefined : execution.error,
		}
		if (existing.schedule.type === 'once') {
			await this.ctx.storage.delete(getJobStorageKey(jobId))
			await this.syncAlarm()
		} else {
			await this.ctx.storage.put(getJobStorageKey(jobId), updated)
		}
		return {
			job: toScheduledJobView(updated),
			execution,
		}
	}

	private async executeJob(
		job: ScheduledJob,
		callerContext: PersistedSchedulerCallerContext | null,
	): Promise<SchedulerExecutionResult> {
		if (!callerContext) {
			return {
				ok: false,
				error:
					'Scheduler caller context is missing. Update or recreate a scheduled job to refresh its execution context.',
				logs: [],
			}
		}
		const execution = await runCodemodeWithRegistry(
			this.env,
			callerContext,
			job.code,
			job.params,
			workerExports,
		)
		if (execution.error) {
			return {
				ok: false,
				error: formatSchedulerError(execution.error),
				logs: execution.logs ?? [],
			}
		}
		return {
			ok: true,
			result: execution.result,
			logs: execution.logs ?? [],
		}
	}

	private async parseMutationRequest<TBody>(request: Request) {
		const raw = (await request.json()) as {
			callerContext?: unknown
			body?: TBody
		}
		const callerContext = requirePersistableSchedulerCallerContext(
			parseMcpCallerContext(raw.callerContext),
		)
		if (raw.body === undefined) {
			throw new Error('Scheduler mutation requests require a JSON body.')
		}
		return {
			callerContext,
			body: raw.body,
		}
	}

	private async persistCallerContext(
		callerContext: PersistedSchedulerCallerContext,
	) {
		await this.ctx.storage.put(callerContextStorageKey, callerContext)
	}

	private async getPersistedCallerContext() {
		return (
			(await this.ctx.storage.get<PersistedSchedulerCallerContext>(
				callerContextStorageKey,
			)) ?? null
		)
	}

	private async requireStoredJob(jobId: string) {
		const job = await this.ctx.storage.get<ScheduledJob>(
			getJobStorageKey(jobId),
		)
		if (!job) {
			throw new Error(`Scheduled job "${jobId}" was not found.`)
		}
		return {
			...job,
			timezone: normalizeSchedulerTimezone(job.timezone),
		}
	}

	private async listStoredJobs() {
		const jobs = [
			...(
				await this.ctx.storage.list<ScheduledJob>({
					prefix: jobStorageKeyPrefix,
				})
			).values(),
		].map((job) => ({
			...job,
			timezone: normalizeSchedulerTimezone(job.timezone),
		}))
		return jobs.sort((left, right) => {
			const leftTime = new Date(left.nextRunAt).valueOf()
			const rightTime = new Date(right.nextRunAt).valueOf()
			if (leftTime !== rightTime) return leftTime - rightTime
			return left.name.localeCompare(right.name)
		})
	}

	private async syncAlarm() {
		const enabledJobs = (await this.listStoredJobs()).filter(
			(job) => job.enabled,
		)
		if (enabledJobs.length === 0) {
			await this.ctx.storage.deleteAlarm()
			return
		}
		const nextRunJob = enabledJobs.reduce((earliest, job) =>
			new Date(job.nextRunAt).valueOf() < new Date(earliest.nextRunAt).valueOf()
				? job
				: earliest,
		)
		await this.ctx.storage.setAlarm(new Date(nextRunJob.nextRunAt))
	}
}

export const SchedulerDO = Sentry.instrumentDurableObjectWithSentry(
	(env: Env) => buildSentryOptions(env),
	SchedulerDOBase,
)
