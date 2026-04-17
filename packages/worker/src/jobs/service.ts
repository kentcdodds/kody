import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { parseMcpCallerContext } from '#mcp/context.ts'
import { buildJobEmbedText } from '#mcp/jobs-embed.ts'
import { deleteJobVector, upsertJobVector } from '#mcp/jobs-vectorize.ts'
import { type ExecuteResult } from '@cloudflare/codemode'
import { exports as workerExports } from 'cloudflare:workers'
import { applyExecutionOutcome, processDueJobs } from './process-due-jobs.ts'
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
import { createJobStorageId } from '#worker/storage-runner.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { parseRepoManifest } from '#worker/repo/manifest.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import { buildJobSourceFiles } from '#worker/repo/source-templates.ts'

function hasRepoBackedJobSource(input: {
	sourceId?: string | null
}) {
	return typeof input.sourceId === 'string' && input.sourceId.length > 0
}

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

function hasModuleStyleCodemodeEntrypoint(code: string) {
	return (
		/^\s*export\s+/m.test(code) ||
		/\bmodule\.exports\b/.test(code) ||
		/\bexports\.[A-Za-z_$][\w$]*/.test(code)
	)
}

function normalizeOptionalParams(
	params: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
	return params === null || params === undefined ? undefined : params
}

function resolveCreateShape(input: JobCreateInput) {
	if (hasRepoBackedJobSource(input)) {
		return {
			code: input.code == null ? null : normalizeJobCode(input.code),
			sourceId: input.sourceId ?? null,
			publishedCommit: input.publishedCommit ?? null,
		}
	}
	return {
		code: normalizeJobCode(input.code ?? ''),
		sourceId: null,
		publishedCommit: null,
	}
}

function resolveUpdatedShape(input: {
	existing: JobRecord
	body: JobUpdateInput
}) {
	const nextCode =
		input.body.code === undefined
			? input.existing.code
			: input.body.code === null
				? undefined
				: normalizeJobCode(input.body.code)
	const nextSourceId =
		input.body.sourceId === undefined
			? input.existing.sourceId
			: input.body.sourceId
	const nextPublishedCommit =
		input.body.publishedCommit === undefined
			? input.existing.publishedCommit
			: input.body.publishedCommit
	if (!nextCode && !nextSourceId) {
		throw new Error('Jobs require either code or sourceId.')
	}
	return {
		code: nextCode,
		sourceId: nextSourceId ?? null,
		publishedCommit: nextPublishedCommit ?? null,
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
	const jobId = crypto.randomUUID()
	const ensuredSource = shape.sourceId
		? await ensureEntitySource({
				db: input.env.APP_DB,
				env: input.env,
				id: shape.sourceId,
				userId: callerContext.user.userId,
				entityKind: 'job',
				entityId: jobId,
				sourceRoot: '/',
			})
		: null
	const job: JobRecord = {
		version: 1,
		id: jobId,
		userId: callerContext.user.userId,
		name: normalizeJobName(input.body.name),
		code: shape.code,
		sourceId: ensuredSource?.id ?? shape.sourceId ?? null,
		publishedCommit: shape.publishedCommit ?? null,
		storageId: createJobStorageId(jobId),
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
	const syncedPublishedCommit = await syncArtifactSourceSnapshot({
		env: input.env,
		userId: callerContext.user.userId,
		baseUrl: callerContext.baseUrl,
		sourceId: job.sourceId,
		files: buildJobSourceFiles({
			job: toJobView(job),
		}),
	})
	if (syncedPublishedCommit) {
		job.publishedCommit = syncedPublishedCommit
	}
	const callerContextJson = serializeCallerContext(callerContext)
	await insertJobRow({
		db: input.env.APP_DB,
		userId: callerContext.user.userId,
		job,
		callerContextJson,
	})
	await upsertJobVector(input.env, {
		jobId: job.id,
		userId: callerContext.user.userId,
		embedText: buildJobEmbedText({
			name: job.name,
			scheduleSummary: toJobView(job).scheduleSummary,
			sourceId: job.sourceId,
			publishedCommit: job.publishedCommit,
		}),
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
	if (
		input.body.sourceId !== undefined &&
		existing.sourceId != null &&
		input.body.sourceId !== existing.sourceId
	) {
		throw new Error(
			`Job "${existing.id}" cannot change sourceId after it is assigned.`,
		)
	}
	const ensuredSource =
		shape.sourceId && shape.sourceId !== existing.sourceId
			? await ensureEntitySource({
					db: input.env.APP_DB,
					env: input.env,
					id: shape.sourceId,
					userId: callerContext.user.userId,
					entityKind: 'job',
					entityId: existing.id,
					sourceRoot: '/',
				})
			: null
	const updated: JobRecord = {
		...existing,
		name:
			input.body.name === undefined
				? existing.name
				: normalizeJobName(input.body.name),
		code: shape.code ?? null,
		sourceId: ensuredSource?.id ?? shape.sourceId ?? null,
		publishedCommit: shape.publishedCommit ?? null,
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
	const syncedPublishedCommit = await syncArtifactSourceSnapshot({
		env: input.env,
		userId: callerContext.user.userId,
		baseUrl: callerContext.baseUrl,
		sourceId: updated.sourceId,
		files: buildJobSourceFiles({
			job: toJobView(updated),
		}),
	})
	if (syncedPublishedCommit) {
		updated.publishedCommit = syncedPublishedCommit
	}
	const nextCallerContextJson = serializeCallerContext(callerContext)
	await updateJobRow({
		db: input.env.APP_DB,
		userId: callerContext.user.userId,
		job: updated,
		callerContextJson: nextCallerContextJson,
	})
	await upsertJobVector(input.env, {
		jobId: updated.id,
		userId: callerContext.user.userId,
		embedText: buildJobEmbedText({
			name: updated.name,
			scheduleSummary: toJobView(updated).scheduleSummary,
			sourceId: updated.sourceId,
			publishedCommit: updated.publishedCommit,
		}),
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
	await deleteJobVector(input.env, input.jobId)
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
			const runtimeCallerContext = {
				...input.callerContext,
				storageContext: {
					sessionId: input.callerContext.storageContext?.sessionId ?? null,
					appId: input.callerContext.storageContext?.appId ?? null,
					storageId: input.job.storageId,
				},
				repoContext: input.job.sourceId
					? (input.callerContext.repoContext ?? null)
					: null,
			}
			const { runCodemodeWithRegistry } =
				await import('#mcp/run-codemode-registry.ts')
			const result = input.job.sourceId
				? await runRepoBackedJob({
						env: input.env,
						job: input.job,
						callerContext: runtimeCallerContext,
					})
				: await runCodemodeWithRegistry(
						input.env,
						runtimeCallerContext,
						input.job.code ?? '',
						input.job.params,
						{
							executorExports: workerExports,
							storageTools: {
								userId: input.callerContext.user.userId,
								storageId: input.job.storageId,
								writable: true,
							},
						},
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

async function runRepoBackedJob(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
}): Promise<ExecuteResult> {
	if (!input.job.sourceId) {
		return {
			error: 'Repo-backed job source is missing.',
			result: null,
			logs: [],
		}
	}
	const sessionId = `job-runtime-${input.job.id}-${crypto.randomUUID()}`
	const sessionClient = repoSessionRpc(input.env, sessionId)
	const session = await sessionClient.openSession({
		sessionId,
		sourceId: input.job.sourceId,
		userId: input.callerContext.user.userId,
		baseUrl: input.callerContext.baseUrl,
		sourceRoot: '/',
	})
	try {
		const result = await sessionClient.runChecks({
			sessionId: session.id,
			userId: input.callerContext.user.userId,
		})
		if (!result.ok) {
			return {
				error: result.results
					.filter((entry) => !entry.ok)
					.map((entry) => entry.message)
					.join('\n'),
				result: null,
				logs: [],
			}
		}
		const manifestPath =
			session.manifest_path?.replace(/^\/+/, '') || 'kody.json'
		const entrypoint = await sessionClient.readFile({
			sessionId: session.id,
			userId: input.callerContext.user.userId,
			path: manifestPath,
		})
		if (!entrypoint.content) {
			return {
				error: `Job manifest "${manifestPath}" was not found in repo session.`,
				result: null,
				logs: [],
			}
		}
		let manifest: ReturnType<typeof parseRepoManifest>
		try {
			manifest = parseRepoManifest({
				content: entrypoint.content,
				manifestPath,
			})
		} catch (error) {
			return {
				error: error instanceof Error ? error.message : String(error),
				result: null,
				logs: [],
			}
		}
		if (manifest.kind !== 'job') {
			return {
				error: `Repo source "${input.job.sourceId}" is not a job manifest.`,
				result: null,
				logs: [],
			}
		}
		const moduleFile = await sessionClient.readFile({
			sessionId: session.id,
			userId: input.callerContext.user.userId,
			path: manifest.entrypoint.replace(/^\/+/, ''),
		})
		if (!moduleFile.content) {
			return {
				error: `Job entrypoint "${manifest.entrypoint}" was not found in repo session.`,
				result: null,
				logs: [],
			}
		}
		if (hasModuleStyleCodemodeEntrypoint(moduleFile.content)) {
			return {
				error:
					'Repo-backed job entrypoints must be execute-compatible async function snippets, not ESM/CommonJS modules.',
				result: null,
				logs: [],
			}
		}
		const { runCodemodeWithRegistry } =
			await import('#mcp/run-codemode-registry.ts')
		return await runCodemodeWithRegistry(
			input.env,
			{
				...input.callerContext,
				repoContext: {
					sourceId: session.source_id,
					repoId: null,
					sessionId: session.id,
					sessionRepoId: session.session_repo_id,
					baseCommit: session.base_commit,
					manifestPath: session.manifest_path,
					sourceRoot: session.source_root,
					publishedCommit: session.published_commit,
					entityKind: session.entity_type,
					entityId: input.job.id,
				},
			},
			moduleFile.content,
			input.job.params,
			{
				executorExports: workerExports,
				storageTools: {
					userId: input.callerContext.user.userId,
					storageId: input.job.storageId,
					writable: true,
				},
			},
		)
	} finally {
		await sessionClient
			.discardSession({
				sessionId: session.id,
				userId: input.callerContext.user.userId,
			})
			.catch(() => {
				// Best effort only; preserve the original execution failure.
			})
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
		await deleteJobVector(input.env, input.jobId)
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
		await deleteJobVector(input.env, jobId)
	}
	return dueRows.length
}

export async function getNextRunnableJob(input: { env: Env; userId: string }) {
	const row = await getNextRunnableJobRow(input.env.APP_DB, input.userId)
	return row?.record ?? null
}
