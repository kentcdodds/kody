import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { createMcpCallerContext, parseMcpCallerContext } from '#mcp/context.ts'
import { buildJobEmbedText } from '#mcp/jobs-embed.ts'
import { deleteJobVector, upsertJobVector } from '#mcp/jobs-vectorize.ts'
import { type ExecuteResult } from '@cloudflare/codemode'
import { applyExecutionOutcome, processDueJobs } from './process-due-jobs.ts'
import {
	getJobManagerDebugState,
	syncJobManagerAlarm,
} from './manager-client.ts'
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
import {
	createJobStorageId,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import {
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import { getManifestEntrypointPath, parseRepoManifest } from '#worker/repo/manifest.ts'
import { typecheckPackageEntrypointsFromSourceFiles } from '#worker/repo/checks.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import { buildJobSourceFiles } from '#worker/repo/source-templates.ts'
import { repoBackedModuleEntrypointExportErrorMessage } from '#worker/repo/repo-codemode-execution.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-codemode-registry.ts'
import {
	deleteEntitySource,
	getEntitySourceById,
} from '#worker/repo/entity-sources.ts'
import { loadPublishedEntitySource } from '#worker/repo/published-source.ts'
import {
	deletePublishedArtifactsForSource,
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import {
	deleteArchivedJobArtifact,
	listArchivedJobArtifactsDueBefore,
	upsertArchivedJobArtifact,
} from './archived-artifacts-repo.ts'
import { deletePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	logJobSchedulerError,
	logJobSchedulerEvent,
	schedulerErrorFields,
	type SchedulerJobOutcomeLog,
} from './scheduler-logging.ts'

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

async function buildPublishedJobBundle(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
}) {
	// Load the worker bundler lazily so registry-only/node test paths that import
	// jobs/service.ts do not eagerly pull the heavy bundler stack.
	const { buildKodyModuleBundle } = await import(
		'#worker/package-runtime/module-graph.ts'
	)
	return await buildKodyModuleBundle(input)
}

async function persistPublishedJobBundleArtifact(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
	sourceId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	artifactName?: string | null
	packageContext?: {
		packageId: string
		kodyId: string
	} | null
}) {
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source?.published_commit) {
		return null
	}
	logJobSchedulerEvent({
		event: 'job_bundle_build_started',
		userId: input.callerContext.user.userId,
		jobId: input.job.id,
		sourceId: input.sourceId,
		artifactEntryPoint: input.entryPoint,
		reason: 'bundle_missing_or_stale',
	})
	const bundle = await buildPublishedJobBundle({
		env: input.env,
		baseUrl: input.callerContext.baseUrl,
		userId: input.callerContext.user.userId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
	})
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.callerContext.user.userId,
		source,
		kind: 'job',
		artifactName: input.artifactName,
		entryPoint: input.entryPoint,
		mainModule: bundle.mainModule,
		modules: bundle.modules,
		dependencies: bundle.dependencies,
		packageContext: input.packageContext ?? null,
	})
	logJobSchedulerEvent({
		event: 'job_bundle_build_completed',
		userId: input.callerContext.user.userId,
		jobId: input.job.id,
		sourceId: input.sourceId,
		artifactEntryPoint: input.entryPoint,
		artifactCacheHit: false,
		dependencyCount: bundle.dependencies.length,
	})
	return bundle
}

async function ensurePublishedBundleArtifactForJob(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
}) {
	if (!input.job.sourceId) {
		throw new Error('Repo-backed job source is missing.')
	}
	const source = await getEntitySourceById(input.env.APP_DB, input.job.sourceId)
	if (!source) {
		throw new Error(`Source "${input.job.sourceId}" was not found.`)
	}
	const artifactName =
		source.entity_kind === 'package' ? input.job.name : input.job.id
	const published = await loadPublishedEntitySource({
		env: input.env,
		userId: input.callerContext.user.userId,
		sourceId: input.job.sourceId,
	})
	const publishedSource = published.source
	if (!publishedSource) {
		throw new Error(`Published source "${input.job.sourceId}" was not found.`)
	}
	const manifestPath = publishedSource.manifest_path
	const manifestContent = published.files[manifestPath]
	if (!manifestContent) {
		throw new Error(`Job manifest "${manifestPath}" was not found.`)
	}
	let entryPoint: string
	let packageContext: {
		packageId: string
		kodyId: string
	} | null = null
	if (manifestPath === 'kody.json' || publishedSource.entity_kind === 'job') {
		const manifest = parseRepoManifest({
			content: manifestContent,
			manifestPath,
		})
		if (manifest.kind !== 'job') {
			throw new Error(`Repo source "${input.job.sourceId}" is not a job manifest.`)
		}
		entryPoint = getManifestEntrypointPath(manifest)
	} else {
		const manifest = parseAuthoredPackageJson({
			content: manifestContent,
			manifestPath,
		})
		const jobDefinition = manifest.kody.jobs?.[input.job.name]
		if (!jobDefinition) {
			throw new Error(
				`Package "${manifest.kody.id}" does not define job "${input.job.name}".`,
			)
		}
		entryPoint = normalizePackageWorkspacePath(jobDefinition.entry)
		packageContext = {
			packageId: source.entity_id,
			kodyId: manifest.kody.id,
		}
	}
	const artifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.callerContext.user.userId,
		sourceId: input.job.sourceId,
		kind: 'job',
		artifactName,
		entryPoint,
	})
	if (artifact?.artifact) {
		logJobSchedulerEvent({
			event: 'job_bundle_cache_hit',
			userId: input.callerContext.user.userId,
			jobId: input.job.id,
			sourceId: input.job.sourceId,
			artifactEntryPoint: artifact.row?.entryPoint ?? 'unknown',
			artifactCacheHit: true,
			dependencyCount: artifact.artifact.dependencies.length,
		})
		return artifact.artifact
	}
	logJobSchedulerEvent({
		event: 'job_bundle_cache_miss',
		userId: input.callerContext.user.userId,
		jobId: input.job.id,
		sourceId: input.job.sourceId,
		artifactCacheHit: false,
		reason: 'bundle_not_found',
	})
	if (packageContext) {
		const typecheckResult = await typecheckPackageEntrypointsFromSourceFiles({
			sourceFiles: published.files,
			entryPoints: [
				{
					path: entryPoint,
					includeStorage: true,
				},
			],
		})
		if (!typecheckResult.ok) {
			throw new Error(typecheckResult.message)
		}
	}
	await persistPublishedJobBundleArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		sourceId: input.job.sourceId,
		sourceFiles: published.files,
		entryPoint,
		artifactName,
		packageContext,
	})
	const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.callerContext.user.userId,
		sourceId: input.job.sourceId,
		kind: 'job',
		artifactName,
		entryPoint,
	})
	if (!loadedArtifact?.artifact) {
		throw new Error(
			`Published bundle artifact for job "${input.job.id}" could not be loaded after rebuild.`,
		)
	}
	return loadedArtifact.artifact
}

async function rebuildAndExecuteJobArtifact(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
	sourceFiles: Record<string, string>
	entryPoint: string
	artifactName?: string | null
	packageContext?: {
		packageId: string
		kodyId: string
	} | null
}) {
	if (!input.job.sourceId) {
		throw new Error('Repo-backed job source is missing.')
	}
	await persistPublishedJobBundleArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		sourceId: input.job.sourceId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
		artifactName: input.artifactName,
		packageContext: input.packageContext ?? null,
	})
	const artifact = await ensurePublishedBundleArtifactForJob({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
	})
	return await executePublishedJobArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		artifact,
		bypassLogs: [],
	})
}

async function executePublishedJobArtifact(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
	artifact: Awaited<ReturnType<typeof ensurePublishedBundleArtifactForJob>>
	bypassLogs: Array<string>
}): Promise<ExecuteResult> {
	const source = await getEntitySourceById(input.env.APP_DB, input.job.sourceId)
	return await runBundledModuleWithRegistry(
		input.env,
		{
			...input.callerContext,
			repoContext: source
				? {
						sourceId: source.id,
						repoId: source.repo_id,
						sessionId: null,
						sessionRepoId: null,
						baseCommit: source.published_commit,
						manifestPath: source.manifest_path,
						sourceRoot: source.source_root,
						publishedCommit: source.published_commit,
						entityKind: source.entity_kind,
						entityId: source.entity_id,
					}
				: null,
		},
		{
			mainModule: input.artifact.mainModule,
			modules: input.artifact.modules,
		},
		input.job.params,
		{
			storageTools: {
				userId: input.callerContext.user.userId,
				storageId: input.job.storageId,
				writable: true,
			},
			...(input.artifact.packageContext
				? { packageContext: input.artifact.packageContext }
				: {}),
		},
	).then((result) => ({
		...result,
		logs: [...input.bypassLogs, ...(result.logs ?? [])],
	}))
}

function buildPackageJobId(packageId: string, jobName: string) {
	return `package-job:${packageId}:${encodeURIComponent(jobName)}`
}

function computeArchivedJobRetainUntil(input: { now?: Date } = {}) {
	const now = input.now ?? new Date()
	return new Date(now.valueOf() + 60 * 60 * 1000).toISOString()
}

async function archiveSuccessfulOneOffJob(input: {
	env: Env
	job: JobRecord
	now?: Date
}) {
	if (!input.job.sourceId || !input.job.publishedCommit) {
		return
	}
	await upsertArchivedJobArtifact({
		db: input.env.APP_DB,
		jobId: input.job.id,
		userId: input.job.userId,
		sourceId: input.job.sourceId,
		publishedCommit: input.job.publishedCommit,
		storageId: input.job.storageId,
		retainUntil: computeArchivedJobRetainUntil({ now: input.now }),
	})
	logJobSchedulerEvent({
		event: 'job_artifact_archived',
		userId: input.job.userId,
		jobId: input.job.id,
		sourceId: input.job.sourceId,
		reason: 'successful_one_off_retention',
	})
}

async function cleanupArchivedJobArtifacts(input: {
	env: Env
	now?: Date
}) {
	const due = await listArchivedJobArtifactsDueBefore(
		input.env.APP_DB,
		(input.now ?? new Date()).toISOString(),
	)
	for (const artifact of due) {
		try {
			const source = await getEntitySourceById(input.env.APP_DB, artifact.sourceId)
			if (source) {
				await deletePublishedArtifactsForSource({
					env: input.env,
					userId: artifact.userId,
					sourceId: source.id,
				})
				await deletePublishedSourceSnapshot({
					env: input.env,
					sourceId: source.id,
					publishedCommit: source.published_commit,
				})
				await deleteEntitySource(input.env.APP_DB, {
					id: source.id,
					userId: artifact.userId,
				})
			}
			await storageRunnerRpc({
				env: input.env,
				userId: artifact.userId,
				storageId: artifact.storageId,
			}).clearStorage()
			await deleteArchivedJobArtifact(input.env.APP_DB, artifact.id)
			logJobSchedulerEvent({
				event: 'job_artifact_cleanup_completed',
				userId: artifact.userId,
				jobId: artifact.jobId,
				sourceId: artifact.sourceId,
				reason: 'retention_elapsed',
			})
		} catch (error) {
			logJobSchedulerError({
				event: 'job_artifact_cleanup_failed',
				userId: artifact.userId,
				jobId: artifact.jobId,
				sourceId: artifact.sourceId,
				reason: 'retention_elapsed',
				...schedulerErrorFields(error),
			})
		}
	}
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
	const packageRows = existingRows.filter(
		(row) => row.source_id === input.sourceId,
	)
	const existingByName = new Map(
		packageRows.map((row) => [row.name, row] as const),
	)
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
			storageId: createJobStorageId(
				buildPackageJobId(input.packageId, jobName),
			),
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
	await syncJobManagerAlarm({
		env: input.env,
		userId: callerContext.user.userId,
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

export async function inspectJobsForUser(input: { env: Env; userId: string }) {
	const [jobs, alarm] = await Promise.all([
		listJobs(input),
		getJobManagerDebugState({
			env: input.env,
			userId: input.userId,
		}),
	])
	return {
		jobs,
		alarm,
	}
}

export async function getJobInspection(input: {
	env: Env
	userId: string
	jobId: string
}) {
	const [job, alarm] = await Promise.all([
		getJob(input),
		getJobManagerDebugState({
			env: input.env,
			userId: input.userId,
		}),
	])
	return {
		job,
		alarm,
	}
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
	await syncJobManagerAlarm({
		env: input.env,
		userId: callerContext.user.userId,
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
	await syncJobManagerAlarm({
		env: input.env,
		userId: input.userId,
	})
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
	const source = await getEntitySourceById(input.env.APP_DB, input.job.sourceId)
	if (!source?.published_commit) {
		return {
			error: `Source "${input.job.sourceId}" has no published commit.`,
			result: null,
			logs: [],
		}
	}
	const artifactName =
		source.entity_kind === 'package' ? input.job.name : input.job.id
	const publishedSource = await loadPublishedEntitySource({
		env: input.env,
		userId: input.callerContext.user.userId,
		sourceId: input.job.sourceId,
	})
	const manifestPath = source.manifest_path.replace(/^\/+/, '')
	const manifestContent = publishedSource.files[manifestPath]
	if (!manifestContent) {
		return {
			error: `Job manifest "${manifestPath}" was not found in published source.`,
			result: null,
			logs: [],
		}
	}
	if (source.entity_kind === 'job' || manifestPath === 'kody.json') {
		let manifest: ReturnType<typeof parseRepoManifest>
		try {
			manifest = parseRepoManifest({
				content: manifestContent,
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
		const entryPoint = getManifestEntrypointPath(manifest)
		const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
			env: input.env,
			userId: input.callerContext.user.userId,
			sourceId: input.job.sourceId,
			kind: 'job',
			artifactName,
			entryPoint,
		})
		if (loadedArtifact?.artifact) {
			return await executePublishedJobArtifact({
				env: input.env,
				job: input.job,
				callerContext: input.callerContext,
				artifact: loadedArtifact.artifact,
				bypassLogs: [],
			})
		}
		return await rebuildAndExecuteJobArtifact({
			env: input.env,
			job: input.job,
			callerContext: input.callerContext,
			sourceFiles: publishedSource.files,
			entryPoint,
			artifactName,
			packageContext: null,
		})
	}

	let manifest: ReturnType<typeof parseAuthoredPackageJson>
	try {
		manifest = parseAuthoredPackageJson({
			content: manifestContent,
			manifestPath,
		})
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
			result: null,
			logs: [],
		}
	}
	const jobDefinition = manifest.kody.jobs?.[input.job.name]
	if (!jobDefinition) {
		return {
			error: `Package "${manifest.kody.id}" does not define job "${input.job.name}".`,
			result: null,
			logs: [],
		}
	}
	const entryPoint = normalizePackageWorkspacePath(jobDefinition.entry)
	const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.callerContext.user.userId,
		sourceId: input.job.sourceId,
		kind: 'job',
		artifactName,
		entryPoint,
	})
	if (loadedArtifact?.artifact) {
		return await executePublishedJobArtifact({
			env: input.env,
			job: input.job,
			callerContext: input.callerContext,
			artifact: loadedArtifact.artifact,
			bypassLogs: [],
		})
	}
	return await rebuildAndExecuteJobArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		sourceFiles: publishedSource.files,
		entryPoint,
		artifactName,
		packageContext: {
			packageId: source.entity_id ?? input.job.id,
			kodyId: manifest.kody.id,
		},
	})
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
			? applyExecutionOutcome(
					row.record,
					outcome,
					outcome.execution.ok ? {} : { enabled: false },
				)
			: applyExecutionOutcome(row.record, outcome, {
					nextRunAt: computeNextRunAt({
						schedule: row.record.schedule,
						timezone: row.record.timezone,
						from: outcome.finishedAt,
					}),
				})
	const deletedAfterRun =
		row.record.schedule.type === 'once' && outcome.execution.ok
	if (deletedAfterRun) {
		await archiveSuccessfulOneOffJob({
			env: input.env,
			job: row.record,
		})
		await deleteJobRow(input.env.APP_DB, input.userId, input.jobId)
		await deleteJobVector(input.env, input.jobId)
		await cleanupArchivedJobArtifacts({
			env: input.env,
		})
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
		deletedAfterRun,
	}
}

export async function runDueJobsForUser(input: {
	env: Env
	userId: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const dueRows = await listDueJobRows(
		input.env.APP_DB,
		input.userId,
		now.toISOString(),
	)
	const dueRowById = new Map(
		dueRows.map((row) => [row.record.id, row] as const),
	)
	if (dueRows.length === 0) {
		logJobSchedulerEvent({
			event: 'run_due_jobs_empty',
			userId: input.userId,
			dueJobCount: 0,
			reason: 'no_due_jobs',
		})
		return {
			dueJobCount: 0,
			successCount: 0,
			errorCount: 0,
			jobOutcomes: [] satisfies Array<SchedulerJobOutcomeLog>,
		}
	}
	const result = await processDueJobs({
		jobs: dueRows.map((row) => row.record),
		now,
		executeJob: async (job) => {
			const row = dueRowById.get(job.id)
			const callerContext = row?.callerContext ?? null
			return executeJobOnce({
				env: input.env,
				job,
				callerContext,
			})
		},
	})
	for (const job of result.saveJobs) {
		const row = dueRowById.get(job.id)
		await updateJobRow({
			db: input.env.APP_DB,
			userId: input.userId,
			job,
			callerContextJson: row?.callerContextJson ?? 'null',
		})
	}
	for (const jobId of result.deleteJobIds) {
		const row = dueRowById.get(jobId)
		if (row) {
			await archiveSuccessfulOneOffJob({
				env: input.env,
				job: row.record,
				now,
			})
		}
		await deleteJobRow(input.env.APP_DB, input.userId, jobId)
		await deleteJobVector(input.env, jobId)
	}
	await cleanupArchivedJobArtifacts({
		env: input.env,
		now,
	})
	return {
		dueJobCount: dueRows.length,
		successCount: result.successCount,
		errorCount: result.errorCount,
		jobOutcomes: result.jobOutcomes,
	}
}

export async function getNextRunnableJob(input: { env: Env; userId: string }) {
	const row = await getNextRunnableJobRow(input.env.APP_DB, input.userId)
	return row?.record ?? null
}
