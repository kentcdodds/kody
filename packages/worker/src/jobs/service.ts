import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { parseMcpCallerContext } from '#mcp/context.ts'
import { exports as workerExports } from 'cloudflare:workers'
import {
	applyExecutionOutcome,
	processDueJobs,
} from './process-due-jobs.ts'
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
		throw new Error('Codemode jobs require non-empty code.')
	}
	return trimmed
}

function normalizeJobServerCode(serverCode: string) {
	const trimmed = serverCode.trim()
	if (!trimmed) {
		throw new Error('Facet jobs require non-empty serverCode.')
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

function resolveCreateShape(input: JobCreateInput) {
	if (input.kind === 'codemode') {
		if (input.serverCode !== undefined) {
			throw new Error('Codemode jobs do not accept serverCode.')
		}
		if (input.methodName !== undefined && input.methodName !== null) {
			throw new Error('Codemode jobs do not accept methodName.')
		}
		return {
			code: normalizeJobCode(input.code ?? ''),
			serverCode: undefined,
			serverCodeId: undefined,
			methodName: undefined,
		}
	}
	if (input.code !== undefined) {
		throw new Error('Facet jobs do not accept code.')
	}
	return {
		code: undefined,
		serverCode: normalizeJobServerCode(input.serverCode ?? ''),
		serverCodeId: crypto.randomUUID(),
		methodName: normalizeOptionalMethodName(input.methodName),
	}
}

function resolveUpdatedShape(input: {
	existing: JobRecord
	body: JobUpdateInput
}) {
	const nextKind = input.body.kind ?? input.existing.kind
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
			? input.existing.methodName
			: input.body.methodName === null
				? undefined
				: normalizeOptionalMethodName(input.body.methodName)
	const kindChanged =
		input.body.kind !== undefined && input.body.kind !== input.existing.kind

	if (kindChanged) {
		if (nextKind === 'codemode') {
			if (input.body.serverCode === undefined) {
				nextServerCode = undefined
			}
			if (input.body.methodName === undefined) {
				nextMethodName = undefined
			}
		} else if (input.body.code === undefined) {
			nextCode = undefined
		}
	}

	if (nextKind === 'codemode') {
		if (!nextCode) {
			throw new Error('Codemode jobs require code.')
		}
		if (nextServerCode !== undefined || nextMethodName !== undefined) {
			throw new Error('Codemode jobs cannot store facet fields.')
		}
		return {
			kind: nextKind,
			code: nextCode,
			serverCode: undefined,
			serverCodeId: undefined,
			methodName: undefined,
		}
	}

	if (nextCode !== undefined) {
		throw new Error('Facet jobs cannot store codemode code.')
	}
	if (!nextServerCode) {
		throw new Error('Facet jobs require serverCode.')
	}
	nextMethodName = normalizeOptionalMethodName(nextMethodName)
	return {
		kind: nextKind,
		code: undefined,
		serverCode: nextServerCode,
		serverCodeId:
			nextServerCode !== input.existing.serverCode ||
			input.existing.kind !== 'facet'
				? crypto.randomUUID()
				: input.existing.serverCodeId ?? crypto.randomUUID(),
		methodName: nextMethodName,
	}
}

async function syncRunnerForJob(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext | null
}) {
	if (input.job.kind !== 'facet') {
		await deleteJobRunner({
			env: input.env,
			jobId: input.job.id,
		}).catch(() => {})
		return
	}
	if (!input.callerContext?.user?.userId) {
		throw new Error(
			'Facet jobs require persisted caller context with an authenticated user.',
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
		kind: input.body.kind,
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
	await insertJobRow({
		db: input.env.APP_DB,
		userId: callerContext.user.userId,
		job,
		callerContextJson: serializeCallerContext(callerContext),
	})
	await syncRunnerForJob({
		env: input.env,
		job,
		callerContext,
	})
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
		kind: shape.kind,
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
	await updateJobRow({
		db: input.env.APP_DB,
		userId: callerContext.user.userId,
		job: updated,
		callerContextJson: serializeCallerContext(callerContext),
	})
	await syncRunnerForJob({
		env: input.env,
		job: updated,
		callerContext,
	})
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
		} else if (input.job.kind === 'codemode') {
			const { runCodemodeWithRegistry } = await import(
				'#mcp/run-codemode-registry.ts'
			)
			const result = await runCodemodeWithRegistry(
				input.env,
				input.callerContext,
				input.job.code!,
				input.job.params,
				workerExports,
			)
			execution = result.error
				? {
						ok: false,
						error: formatJobError(result.error),
						logs: result.logs ?? [],
					}
				: {
						ok: true,
						result: result.result,
						logs: result.logs ?? [],
					}
		} else {
			const result = await jobRunnerRpc(input.env, input.job.id).runStoredJob({
				jobId: input.job.id,
				methodName: input.job.methodName,
				params: input.job.params,
			})
			execution = {
				ok: true,
				result: result.result,
				logs: [],
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
	if (row.record.kind === 'facet') {
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
	const updated = applyExecutionOutcome(row.record, outcome)
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
			if (job.kind === 'facet') {
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

export async function getNextRunnableJob(input: {
	env: Env
	userId: string
}) {
	const row = await getNextRunnableJobRow(input.env.APP_DB, input.userId)
	return row?.record ?? null
}
