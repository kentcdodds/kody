import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { parseMcpCallerContext } from '#mcp/context.ts'
import { exports as workerExports } from 'cloudflare:workers'
import { applyExecutionOutcome, processDueJobs } from './process-due-jobs.ts'
import {
	configureJobRunner,
	deleteJobRunner,
	jobRunnerRpc,
} from './job-runner.ts'
import {
	deleteJobRow,
	getJobRowById,
	listDueJobRows,
	listJobRowsByUserId,
	getNextRunnableJobRow,
	insertJobRow,
	updateJobRow,
} from './repo.ts'
import {
	computeNextRunAt,
	formatJobError,
	normalizeJobSchedule,
	normalizeJobTimezone,
	toJobView,
} from './schedule.ts'
import {
	type JobCreateInput,
	type JobExecutionOutcome,
	type JobExecutionResult,
	type JobRecord,
	type JobUpdateInput,
	type PersistedJobCallerContext,
} from './types.ts'

const defaultFacetMethodName = 'run'

function requirePersistableJobCallerContext(
	callerContext: McpCallerContext,
): PersistedJobCallerContext {
	const parsed = parseMcpCallerContext(callerContext)
	if (!parsed.user) {
		throw new Error('Authenticated MCP user is required for job operations.')
	}
	return parsed as PersistedJobCallerContext
}

function serializeCallerContext(callerContext: PersistedJobCallerContext) {
	return JSON.stringify(callerContext)
}

function normalizeJobName(name: string) {
	const trimmed = name.trim()
	if (!trimmed) {
		throw new Error('Jobs require a non-empty name.')
	}
	return trimmed
}

function normalizeJobCode(code: string) {
	const trimmed = code.trim()
	if (!trimmed) {
		throw new Error('Jobs require non-empty code.')
	}
	return trimmed
}

function normalizeJobServerCode(serverCode: string) {
	const trimmed = serverCode.trim()
	if (!trimmed) {
		throw new Error('Jobs with facet state require non-empty serverCode.')
	}
	return trimmed
}

function normalizeOptionalParams(
	params: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
	return params === null || params === undefined ? undefined : params
}

function normalizeOptionalMethodName(
	methodName: string | null | undefined,
	fallback = defaultFacetMethodName,
) {
	const trimmed = methodName?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : fallback
}

function hasFacetState(job: Pick<JobRecord, 'serverCode'>) {
	return typeof job.serverCode === 'string' && job.serverCode.trim().length > 0
}

function createJobHelperPrelude() {
	return `
const job = {
  call: async (methodName, ...args) => {
    return await codemode.job_call({
      methodName,
      args,
    });
  },
};
	`.trim()
}

function resolveCreateShape(input: JobCreateInput) {
	const code = normalizeJobCode(input.code)
	if (input.serverCode === undefined) {
		if (input.methodName !== undefined && input.methodName !== null) {
			throw new Error('Jobs without serverCode do not accept methodName.')
		}
		return {
			code,
			serverCode: undefined,
			serverCodeId: undefined,
			methodName: undefined,
		}
	}
	return {
		code,
		serverCode: normalizeJobServerCode(input.serverCode),
		serverCodeId: crypto.randomUUID(),
		methodName: normalizeOptionalMethodName(input.methodName),
	}
}

function resolveUpdatedShape(input: {
	existing: JobRecord
	body: JobUpdateInput
}) {
	let nextCode =
		input.body.code === undefined
			? input.existing.code
			: input.body.code === null
				? undefined
				: normalizeJobCode(input.body.code)
	let nextServerCode =
		input.body.serverCode === undefined
			? input.existing.serverCode
			: input.body.serverCode === null
				? undefined
				: normalizeJobServerCode(input.body.serverCode)
	let nextMethodName =
		input.body.methodName === undefined
			? nextServerCode === undefined
				? undefined
				: input.existing.serverCode === undefined
					? undefined
					: input.existing.methodName
			: input.body.methodName === null
				? undefined
				: normalizeOptionalMethodName(input.body.methodName)

	if (!nextCode) {
		throw new Error('Jobs require code.')
	}
	if (nextServerCode === undefined) {
		if (nextMethodName !== undefined) {
			throw new Error('Jobs without serverCode cannot store methodName.')
		}
		return {
			code: nextCode,
			serverCode: undefined,
			serverCodeId: undefined,
			methodName: undefined,
		}
	}

	nextMethodName = normalizeOptionalMethodName(nextMethodName)
	return {
		code: nextCode,
		serverCode: nextServerCode,
		serverCodeId:
			nextServerCode !== input.existing.serverCode
				? crypto.randomUUID()
				: (input.existing.serverCodeId ?? crypto.randomUUID()),
		methodName: nextMethodName,
	}
}

async function syncRunnerForJob(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext | null
}) {
	if (!hasFacetState(input.job)) {
		await deleteJobRunner({
			env: input.env,
			jobId: input.job.id,
		}).catch(() => {})
		return
	}
	if (!input.callerContext?.user?.userId) {
		throw new Error(
			'Jobs with facet state require persisted caller context with an authenticated user.',
		)
	}
	await configureJobRunner({
		env: input.env,
		jobId: input.job.id,
		userId: input.callerContext.user.userId,
		baseUrl: input.callerContext.baseUrl,
		storageContext: input.callerContext.storageContext,
		serverCode: input.job.serverCode!,
		serverCodeId: input.job.serverCodeId!,
		methodName: input.job.methodName,
		killSwitchEnabled: input.job.killSwitchEnabled,
	})
}

function createJobCodemodeTools(input: { env: Env; job: JobRecord }) {
	if (!hasFacetState(input.job)) {
		return undefined
	}
	return {
		job_call: async (args: unknown) => {
			const payload =
				typeof args === 'object' && args !== null
					? (args as {
							methodName?: unknown
							args?: unknown
						})
					: {}
			const methodName =
				typeof payload.methodName === 'string' ? payload.methodName.trim() : ''
			if (!methodName) {
				throw new Error('job.call requires a non-empty method name.')
			}
			const methodArgs = Array.isArray(payload.args) ? payload.args : []
			return await jobRunnerRpc(input.env, input.job.id).callJobRpc({
				jobId: input.job.id,
				methodName,
				args: methodArgs,
			})
		},
	}
}

export async function createJob(input: {
	env: Env
	callerContext: McpCallerContext
	body: JobCreateInput
}) {
	const callerContext = requirePersistableJobCallerContext(input.callerContext)
	const schedule = normalizeJobSchedule(input.body.schedule)
	const timezone = normalizeJobTimezone(input.body.timezone)
	const now = new Date().toISOString()
	const shape = resolveCreateShape(input.body)
	const job: JobRecord = {
		version: 1,
		id: crypto.randomUUID(),
		userId: callerContext.user.userId,
		name: normalizeJobName(input.body.name),
		code: shape.code,
		serverCode: shape.serverCode,
		serverCodeId: shape.serverCodeId,
		methodName: shape.methodName,
		params: normalizeOptionalParams(input.body.params),
		schedule,
		timezone,
		enabled: input.body.enabled ?? true,
		killSwitchEnabled: input.body.killSwitchEnabled ?? false,
		createdAt: now,
		updatedAt: now,
		nextRunAt: computeNextRunAt({
			schedule,
			timezone,
		}),
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
	}
	const callerContextJson = serializeCallerContext(callerContext)
	await insertJobRow({
		db: input.env.APP_DB,
		userId: callerContext.user.userId,
		job,
		callerContextJson,
	})
	try {
		await syncRunnerForJob({
			env: input.env,
			job,
			callerContext,
		})
	} catch (error) {
		await deleteJobRow(
			input.env.APP_DB,
			callerContext.user.userId,
			job.id,
		).catch(() => {})
		throw error
	}
	return toJobView(job)
}

export async function listJobs(input: { env: Env; userId: string }) {
	const rows = await listJobRowsByUserId(input.env.APP_DB, input.userId)
	return rows.map((row) => toJobView(row.record))
}

export async function getJob(input: {
	env: Env
	userId: string
	jobId: string
}) {
	const row = await getJobRowById(input.env.APP_DB, input.userId, input.jobId)
	if (!row) {
		throw new Error(`Job "${input.jobId}" was not found.`)
	}
	return toJobView(row.record)
}

export async function updateJob(input: {
	env: Env
	callerContext: McpCallerContext
	body: JobUpdateInput
}) {
	const callerContext = requirePersistableJobCallerContext(input.callerContext)
	const existingRow = await getJobRowById(
		input.env.APP_DB,
		callerContext.user.userId,
		input.body.id,
	)
	if (!existingRow) {
		throw new Error(`Job "${input.body.id}" was not found.`)
	}
	const existing = existingRow.record
	const nextSchedule =
		input.body.schedule !== undefined
			? normalizeJobSchedule(input.body.schedule)
			: existing.schedule
	const nextTimezone =
		input.body.timezone === null
			? normalizeJobTimezone(null)
			: normalizeJobTimezone(input.body.timezone ?? existing.timezone)
	const nextEnabled = input.body.enabled ?? existing.enabled
	const shouldRecomputeNextRunAt =
		JSON.stringify(nextSchedule) !== JSON.stringify(existing.schedule) ||
		nextTimezone !== existing.timezone ||
		(existing.enabled === false && nextEnabled === true)
	const shape = resolveUpdatedShape({
		existing,
		body: input.body,
	})
	const updated: JobRecord = {
		...existing,
		name:
			input.body.name === undefined
				? existing.name
				: normalizeJobName(input.body.name),
		code: shape.code,
		serverCode: shape.serverCode,
		serverCodeId: shape.serverCodeId,
		methodName: shape.methodName,
		params:
			input.body.params === undefined
				? existing.params
				: normalizeOptionalParams(input.body.params),
		schedule: nextSchedule,
		timezone: nextTimezone,
		enabled: nextEnabled,
		killSwitchEnabled:
			input.body.killSwitchEnabled ?? existing.killSwitchEnabled,
		updatedAt: new Date().toISOString(),
		nextRunAt: shouldRecomputeNextRunAt
			? computeNextRunAt({
					schedule: nextSchedule,
					timezone: nextTimezone,
				})
			: existing.nextRunAt,
	}
	const nextCallerContextJson = serializeCallerContext(callerContext)
	await updateJobRow({
		db: input.env.APP_DB,
		userId: callerContext.user.userId,
		job: updated,
		callerContextJson: nextCallerContextJson,
	})
	try {
		await syncRunnerForJob({
			env: input.env,
			job: updated,
			callerContext,
		})
	} catch (error) {
		await updateJobRow({
			db: input.env.APP_DB,
			userId: callerContext.user.userId,
			job: existing,
			callerContextJson:
				existingRow.callerContextJson ?? serializeCallerContext(callerContext),
		}).catch(() => {})
		await syncRunnerForJob({
			env: input.env,
			job: existing,
			callerContext: existingRow.callerContext,
		}).catch(() => {})
		throw error
	}
	return toJobView(updated)
}

export async function deleteJob(input: {
	env: Env
	userId: string
	jobId: string
}) {
	const row = await getJobRowById(input.env.APP_DB, input.userId, input.jobId)
	if (!row) {
		throw new Error(`Job "${input.jobId}" was not found.`)
	}
	await deleteJobRow(input.env.APP_DB, input.userId, input.jobId)
	await deleteJobRunner({
		env: input.env,
		jobId: input.jobId,
	}).catch(() => {})
	return {
		id: input.jobId,
		deleted: true as const,
	}
}

export async function executeJobOnce(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext | null
}): Promise<JobExecutionOutcome> {
	const started = new Date()
	let execution: JobExecutionResult
	try {
		if (!input.callerContext) {
			execution = {
				ok: false,
				error:
					'Job caller context is missing. Re-save the job to refresh its execution context.',
				logs: [],
			}
		} else {
			const { runCodemodeWithRegistry } =
				await import('#mcp/run-codemode-registry.ts')
			const usesFacet = hasFacetState(input.job)
			const result = await runCodemodeWithRegistry(
				input.env,
				input.callerContext,
				input.job.code,
				input.job.params,
				{
					executorExports: workerExports,
					additionalTools: createJobCodemodeTools({
						env: input.env,
						job: input.job,
					}),
					helperPrelude: usesFacet ? createJobHelperPrelude() : undefined,
				},
			)
			execution = {
				ok: !result.error,
				...(result.error
					? { error: formatJobError(result.error) }
					: { result: result.result }),
				logs: result.logs ?? [],
			}
		}
	} catch (error) {
		execution = {
			ok: false,
			error: formatJobError(error),
			logs: [],
		}
	}
	const finished = new Date()
	return {
		execution,
		startedAt: started.toISOString(),
		finishedAt: finished.toISOString(),
		durationMs: Math.max(0, finished.valueOf() - started.valueOf()),
	}
}

export async function runJobNow(input: {
	env: Env
	userId: string
	jobId: string
	callerContext?: McpCallerContext | null
}) {
	const row = await getJobRowById(input.env.APP_DB, input.userId, input.jobId)
	if (!row) {
		throw new Error(`Job "${input.jobId}" was not found.`)
	}
	const activeCallerContext = input.callerContext
		? requirePersistableJobCallerContext(input.callerContext)
		: row.callerContext
	if (hasFacetState(row.record)) {
		await syncRunnerForJob({
			env: input.env,
			job: row.record,
			callerContext: activeCallerContext,
		})
	}
	const outcome = await executeJobOnce({
		env: input.env,
		job: row.record,
		callerContext: activeCallerContext,
	})
	const updated =
		row.record.schedule.type === 'once'
			? applyExecutionOutcome(row.record, outcome)
			: applyExecutionOutcome(row.record, outcome, {
					nextRunAt: computeNextRunAt({
						schedule: row.record.schedule,
						timezone: row.record.timezone,
						from: outcome.finishedAt,
					}),
				})
	if (row.record.schedule.type === 'once') {
		await deleteJobRow(input.env.APP_DB, input.userId, input.jobId)
		await deleteJobRunner({
			env: input.env,
			jobId: input.jobId,
		}).catch(() => {})
	} else {
		await updateJobRow({
			db: input.env.APP_DB,
			userId: input.userId,
			job: updated,
			callerContextJson: activeCallerContext
				? serializeCallerContext(activeCallerContext)
				: row.callerContextJson,
		})
	}
	return {
		job: toJobView(updated),
		execution: outcome.execution,
	}
}

export async function runDueJobsForUser(input: {
	env: Env
	userId: string
	now?: Date
}) {
	const dueRows = await listDueJobRows(
		input.env.APP_DB,
		input.userId,
		(input.now ?? new Date()).toISOString(),
	)
	if (dueRows.length === 0) {
		return 0
	}
	const result = await processDueJobs({
		jobs: dueRows.map((row) => row.record),
		now: input.now,
		executeJob: async (job) => {
			const row = dueRows.find((candidate) => candidate.record.id === job.id)
			const callerContext = row?.callerContext ?? null
			if (hasFacetState(job)) {
				await syncRunnerForJob({
					env: input.env,
					job,
					callerContext,
				})
			}
			return executeJobOnce({
				env: input.env,
				job,
				callerContext,
			})
		},
	})
	for (const job of result.saveJobs) {
		const row = dueRows.find((candidate) => candidate.record.id === job.id)
		await updateJobRow({
			db: input.env.APP_DB,
			userId: input.userId,
			job,
			callerContextJson: row?.callerContextJson ?? 'null',
		})
	}
	for (const jobId of result.deleteJobIds) {
		await deleteJobRow(input.env.APP_DB, input.userId, jobId)
		await deleteJobRunner({
			env: input.env,
			jobId,
		}).catch(() => {})
	}
	return dueRows.length
}

export async function getNextRunnableJob(input: { env: Env; userId: string }) {
	const row = await getNextRunnableJobRow(input.env.APP_DB, input.userId)
	return row?.record ?? null
}
