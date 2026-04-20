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
	type JobRepoCheckPolicy,
	type JobRecord,
	type JobUpdateInput,
	type PersistedJobCallerContext,
} from './types.ts'
import { createJobStorageId } from '#worker/storage-runner.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import {
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import { buildJobSourceFiles } from '#worker/repo/source-templates.ts'
import {
	loadRepoSourceFilesFromSession,
	repoBackedModuleEntrypointExportErrorMessage,
} from '#worker/repo/repo-codemode-execution.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-codemode-registry.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'

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
	if (!/\bexport\s+default\b/.test(trimmed)) {
		throw new Error(repoBackedModuleEntrypointExportErrorMessage)
	}
	return trimmed
}

function normalizeOptionalParams(
	params: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
	return params === null || params === undefined ? undefined : params
}

function normalizeJobRepoCheckPolicy(
	policy: JobRepoCheckPolicy | null | undefined,
): JobRepoCheckPolicy | undefined {
	if (!policy) {
		return undefined
	}
	if (policy.allowTypecheckFailures === true) {
		return {
			allowTypecheckFailures: true,
		}
	}
	return undefined
}

function resolveJobRepoCheckPolicy(input: {
	stored: JobRepoCheckPolicy | undefined
	override?: JobRepoCheckPolicy | null
}) {
	if (input.override !== undefined) {
		return normalizeJobRepoCheckPolicy(input.override)
	}
	return normalizeJobRepoCheckPolicy(input.stored)
}

function evaluateRepoCheckGate(input: {
	result: Awaited<ReturnType<ReturnType<typeof repoSessionRpc>['runChecks']>>
	policy: JobRepoCheckPolicy | undefined
	jobId: string
	sourceId: string
}) {
	if (input.result.ok) {
		return {
			proceed: true,
			logs: [] as Array<string>,
		}
	}
	const failingResults = input.result.results.filter((entry) => !entry.ok)
	const onlyTypecheckFailures =
		failingResults.length > 0 &&
		failingResults.every((entry) => entry.kind === 'typecheck')
	if (input.policy?.allowTypecheckFailures === true && onlyTypecheckFailures) {
		console.info('[runRepoBackedJob] bypassing repo typecheck failures', {
			jobId: input.jobId,
			sourceId: input.sourceId,
			runId: input.result.runId,
			treeHash: input.result.treeHash,
			failingKinds: failingResults.map((entry) => entry.kind),
		})
		return {
			proceed: true,
			logs: [
				`Bypassed repo typecheck-only check failures for job "${input.jobId}" (source "${input.sourceId}", check run ${input.result.runId}).`,
			],
		}
	}
	return {
		proceed: false,
		error: failingResults.map((entry) => entry.message).join('\n'),
		logs: [] as Array<string>,
	}
}

function repoSessionNeedsRefresh(session: {
	base_commit: string | null
	published_commit: string | null
}) {
	return (
		session.published_commit != null &&
		session.base_commit !== session.published_commit
	)
}

function createJobRuntimeSessionId(jobId: string) {
	return `job-runtime-${jobId}-${crypto.randomUUID()}`
}

function buildPackageJobId(packageId: string, jobName: string) {
	return `package-job:${packageId}:${encodeURIComponent(jobName)}`
}

function createPackageJobCallerContext(input: {
	baseUrl: string
	userId: string
	packageId: string
}): PersistedJobCallerContext {
	return createMcpCallerContext({
		baseUrl: input.baseUrl,
		user: {
			userId: input.userId,
			email: '',
			displayName: `package:${input.packageId}`,
		},
		storageContext: {
			sessionId: null,
			appId: input.packageId,
			storageId: null,
		},
		repoContext: null,
	}) as PersistedJobCallerContext
}

export async function syncPackageJobsForPackage(input: {
	env: Env
	userId: string
	baseUrl: string
	packageId: string
	sourceId: string
	manifest: Awaited<ReturnType<typeof parseAuthoredPackageJson>>
}) {
	const desiredJobs = input.manifest.kody.jobs ?? {}
	const existingRows = await listJobRowsByUserId(input.env.APP_DB, input.userId)
	const packageRows = existingRows.filter((row) => row.source_id === input.sourceId)
	const existingByName = new Map(packageRows.map((row) => [row.name, row] as const))
	const desiredNames = new Set(Object.keys(desiredJobs))
	const now = new Date().toISOString()

	for (const [jobName, definition] of Object.entries(desiredJobs)) {
		const existing = existingByName.get(jobName)
		const schedule = normalizeJobSchedule(definition.schedule)
		const timezone = normalizeJobTimezone(definition.timezone)
		const enabled = definition.enabled ?? true
		if (existing) {
			const updated: JobRecord = {
				...existing.record,
				name: jobName,
				sourceId: input.sourceId,
				schedule,
				timezone,
				enabled,
				updatedAt: now,
				nextRunAt: computeNextRunAt({
					schedule,
					timezone,
				}),
			}
			await updateJobRow({
				db: input.env.APP_DB,
				userId: input.userId,
				job: updated,
				callerContextJson:
					existing.callerContextJson ||
					JSON.stringify(
						createPackageJobCallerContext({
							baseUrl: input.baseUrl,
							userId: input.userId,
							packageId: input.packageId,
						}),
					),
			})
			continue
		}

		const created: JobRecord = {
			version: 1,
			id: buildPackageJobId(input.packageId, jobName),
			userId: input.userId,
			name: jobName,
			sourceId: input.sourceId,
			publishedCommit: null,
			storageId: createJobStorageId(buildPackageJobId(input.packageId, jobName)),
			schedule,
			timezone,
			enabled,
			killSwitchEnabled: false,
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
			userId: input.userId,
			job: created,
			callerContextJson: serializeCallerContext(
				createPackageJobCallerContext({
					baseUrl: input.baseUrl,
					userId: input.userId,
					packageId: input.packageId,
				}),
			),
		})
	}

	for (const row of packageRows) {
		if (desiredNames.has(row.name)) continue
		await deleteJobRow(input.env.APP_DB, input.userId, row.id)
		await deleteJobVector(input.env, row.id)
	}
}

export async function deletePackageJobsForSourceId(input: {
	env: Env
	userId: string
	sourceId: string
}) {
	const existingRows = await listJobRowsByUserId(input.env.APP_DB, input.userId)
	for (const row of existingRows) {
		if (row.source_id !== input.sourceId) continue
		await deleteJobRow(input.env.APP_DB, input.userId, row.id)
		await deleteJobVector(input.env, row.id)
	}
}

function resolveCreateShape(input: JobCreateInput) {
	return {
		moduleSource: normalizeJobCode(input.code),
		sourceId: input.sourceId ?? null,
		publishedCommit: input.publishedCommit ?? null,
		repoCheckPolicy: normalizeJobRepoCheckPolicy(input.repoCheckPolicy),
	}
}

function resolveUpdatedShape(input: {
	existing: JobRecord
	body: JobUpdateInput
}) {
	const nextSourceId =
		input.body.sourceId === undefined
			? input.existing.sourceId
			: input.body.sourceId
	const nextPublishedCommit =
		input.body.publishedCommit === undefined
			? input.existing.publishedCommit
			: input.body.publishedCommit
	const nextRepoCheckPolicy =
		nextSourceId == null
			? undefined
			: input.body.repoCheckPolicy === undefined
				? input.existing.repoCheckPolicy
				: normalizeJobRepoCheckPolicy(input.body.repoCheckPolicy)
	if (!nextSourceId) {
		throw new Error('Jobs require a repo-backed source.')
	}
	return {
		moduleSource:
			input.body.code === undefined
				? undefined
				: normalizeJobCode(input.body.code),
		sourceId: nextSourceId,
		publishedCommit: nextPublishedCommit ?? null,
		repoCheckPolicy: nextRepoCheckPolicy,
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
	const ensuredSource = await ensureEntitySource({
		db: input.env.APP_DB,
		env: input.env,
		id: shape.sourceId ?? undefined,
		userId: callerContext.user.userId,
		entityKind: 'job',
		entityId: jobId,
		sourceRoot: '/',
		requirePersistence: true,
	})
	const job: JobRecord = {
		version: 1,
		id: jobId,
		userId: callerContext.user.userId,
		name: normalizeJobName(input.body.name),
		sourceId: ensuredSource.id,
		publishedCommit: shape.publishedCommit ?? null,
		repoCheckPolicy: shape.repoCheckPolicy,
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
		bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
		files: buildJobSourceFiles({
			job: toJobView(job),
			moduleSource: shape.moduleSource,
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
	const updated: JobRecord = {
		...existing,
		name:
			input.body.name === undefined
				? existing.name
				: normalizeJobName(input.body.name),
		sourceId: shape.sourceId,
		publishedCommit: shape.publishedCommit ?? null,
		repoCheckPolicy: shape.repoCheckPolicy,
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
		bootstrapAccess: null,
		files: buildJobSourceFiles({
			job: toJobView(updated),
			moduleSource: shape.moduleSource ?? null,
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
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
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
				repoContext: input.callerContext.repoContext ?? null,
			}
			const result = await runRepoBackedJob({
				env: input.env,
				job: input.job,
				callerContext: runtimeCallerContext,
				repoCheckPolicyOverride: input.repoCheckPolicyOverride,
			})
			execution = result.error
				? {
						ok: false,
						error:
							typeof result.error === 'string'
								? result.error
								: formatJobError(result.error),
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
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
}): Promise<ExecuteResult> {
	if (!input.job.sourceId) {
		return {
			error: 'Repo-backed job source is missing.',
			result: null,
			logs: [],
		}
	}
	const sessionId = createJobRuntimeSessionId(input.job.id)
	const sessionClient = repoSessionRpc(input.env, sessionId)
	const openSessionInput = {
		sessionId,
		sourceId: input.job.sourceId,
		userId: input.callerContext.user.userId,
		baseUrl: input.callerContext.baseUrl,
		sourceRoot: null,
	}
	let bypassLogs: Array<string> = []
	try {
		let session = await sessionClient.openSession(openSessionInput)
		if (repoSessionNeedsRefresh(session)) {
			const stalePublishedCommit = session.published_commit
			try {
				await sessionClient.discardSession({
					sessionId: session.id,
					userId: input.callerContext.user.userId,
				})
			} catch (error) {
				throw new Error(
					`Failed to discard stale repo session "${session.id}" before refreshing to published commit "${stalePublishedCommit}".`,
					{ cause: error },
				)
			}
			session = await sessionClient.openSession(openSessionInput)
			if (repoSessionNeedsRefresh(session)) {
				throw new Error(
					`Repo session "${session.id}" still points at base commit "${session.base_commit}" instead of published commit "${session.published_commit}".`,
				)
			}
		}
		const result = await sessionClient.runChecks({
			sessionId: session.id,
			userId: input.callerContext.user.userId,
		})
		const gate = evaluateRepoCheckGate({
			result,
			policy: resolveJobRepoCheckPolicy({
				stored: input.job.repoCheckPolicy,
				override: input.repoCheckPolicyOverride,
			}),
			jobId: input.job.id,
			sourceId: input.job.sourceId,
		})
		if (!gate.proceed) {
			return {
				error: gate.error ?? 'Repo checks failed.',
				result: null,
				logs: gate.logs,
			}
		}
		bypassLogs = [...gate.logs]
		const manifestPath =
			session.manifest_path?.replace(/^\/+/, '') || 'package.json'
		const entrypoint = await sessionClient.readFile({
			sessionId: session.id,
			userId: input.callerContext.user.userId,
			path: manifestPath,
		})
		if (!entrypoint.content) {
			return {
				error: `Job manifest "${manifestPath}" was not found in repo session.`,
				result: null,
				logs: bypassLogs,
			}
		}
		let manifest: ReturnType<typeof parseAuthoredPackageJson>
		try {
			manifest = parseAuthoredPackageJson({
				content: entrypoint.content,
				manifestPath,
			})
		} catch (error) {
			return {
				error: error instanceof Error ? error.message : String(error),
				result: null,
				logs: bypassLogs,
			}
		}
		const jobDefinition = manifest.kody.jobs?.[input.job.name]
		if (!jobDefinition) {
			return {
				error: `Package "${manifest.kody.id}" does not define job "${input.job.name}".`,
				result: null,
				logs: bypassLogs,
			}
		}
		const modulePath = normalizePackageWorkspacePath(jobDefinition.entry)
		const moduleFile = await sessionClient.readFile({
			sessionId: session.id,
			userId: input.callerContext.user.userId,
			path: modulePath,
		})
		if (!moduleFile.content) {
			return {
				error: `Job entrypoint "${jobDefinition.entry}" was not found in repo session.`,
				result: null,
				logs: bypassLogs,
			}
		}
		try {
			const sourceFiles = await loadRepoSourceFilesFromSession({
				sessionClient,
				sessionId: session.id,
				userId: input.callerContext.user.userId,
				sourceRoot: session.source_root,
			})
			const bundled = await buildKodyModuleBundle({
				env: input.env,
				baseUrl: input.callerContext.baseUrl,
				userId: input.callerContext.user.userId,
				sourceFiles,
				entryPoint: modulePath,
				params: input.job.params,
			})
			const source = await getEntitySourceById(input.env.APP_DB, input.job.sourceId)
			const executionResult = await runBundledModuleWithRegistry(
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
						entityId: source?.entity_id ?? input.job.id,
					},
				},
				{
					mainModule: bundled.mainModule,
					modules: bundled.modules,
				},
				input.job.params,
				{
					executorExports: workerExports,
					storageTools: {
						userId: input.callerContext.user.userId,
						storageId: input.job.storageId,
						writable: true,
					},
					packageContext: {
						packageId: source?.entity_id ?? input.job.id,
						kodyId: manifest.kody.id,
					},
				},
			)
			return {
				...executionResult,
				logs: [...bypassLogs, ...(executionResult.logs ?? [])],
			}
		} catch (error) {
			return {
				error: formatJobError(error),
				result: null,
				logs: bypassLogs,
			}
		}
	} catch (error) {
		return {
			error: formatJobError(error),
			result: null,
			logs: bypassLogs,
		}
	} finally {
		try {
			await sessionClient.discardSession({
				sessionId,
				userId: input.callerContext.user.userId,
			})
		} catch {
			// Best effort only; preserve the original execution failure.
		}
	}
}

export async function runJobNow(input: {
	env: Env
	userId: string
	jobId: string
	callerContext?: McpCallerContext | null
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
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
		repoCheckPolicyOverride: input.repoCheckPolicyOverride,
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
