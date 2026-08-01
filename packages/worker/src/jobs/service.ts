import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type ExecuteResult } from '@cloudflare/codemode'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext, parseMcpCallerContext } from '#mcp/context.ts'
import { buildJobEmbedText } from '#mcp/jobs-embed.ts'
import { deleteJobVector, upsertJobVector } from '#mcp/jobs-vectorize.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import {
	abandonRunRecord,
	claimRunRecord,
	finishRunRecord,
	getRunRecord,
} from '#worker/run-records/service.ts'
import { type RunRecordHandle } from '#worker/run-records/types.ts'
import { hydrateJobViewFromRunLog } from './job-run-observability-hydrate.ts'
import { applyExecutionOutcome, processDueJobs } from './process-due-jobs.ts'
import { syncJobManagerAlarm } from './manager-client.ts'
import {
	deleteJobRow,
	claimJobRow,
	disableExpiredJobRowsForUser,
	finalizeClaimedJobRow,
	getJobRowById,
	listDueJobRows,
	listJobRowsByUserId,
	getNextRunnableJobRow,
	insertJobRow,
	retryClaimedJobRow,
	updateJobRow,
} from './repo.ts'
import {
	buildScheduledJobIdempotencyKey,
	computeJobRetryAt,
	executeOrReplayScheduledJobRun,
	isTransientJobExecutionError,
	markPreExecutionTransientError,
	resolveScheduledJobCallerContext,
	TransientJobExecutionError,
} from './execution-safety.ts'
import {
	computeNextRunAt,
	formatJobError,
	isJobExpired,
	normalizeJobExpiresAt,
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
import { createJobStorageId, storageRunnerRpc } from '#worker/storage-runner.ts'
import { assertWithinEntitlement } from '#worker/entitlements/service.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from '#worker/package-runtime/published-source-dependencies.ts'
import {
	normalizePackageWorkspacePath,
	type parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import { hasTopLevelDefaultExport } from '#worker/module-source.ts'
import { typecheckPackageEntrypointsFromSourceFiles } from '#worker/repo/checks.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import { buildJobSourceFiles } from '#worker/repo/source-templates.ts'
import { repoBackedModuleEntrypointExportErrorMessage } from '#worker/repo/repo-kody-execution.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import {
	deleteEntitySource,
	getEntitySourceById,
	getEntitySourceByIdForUser,
} from '#worker/repo/entity-sources.ts'
import { cleanupArtifactReposForSource } from '#worker/repo/artifact-repo-cleanup.ts'
import { deleteRepoSessionsBySourceForUser } from '#worker/repo/repo-sessions.ts'
import {
	deletePublishedArtifactsForSource,
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import { resolvePublishedJobSource } from './inspect-published-source.ts'
import {
	getJob,
	getJobInspection,
	inspectJobsForUser,
	listJobs,
} from './inspect.ts'
import {
	deleteArchivedJobArtifact,
	listArchivedJobArtifactsDueBefore,
} from './archived-artifacts-repo.ts'
import {
	deletePublishedSourceSnapshot,
	type PublishedBundleArtifact,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	logJobSchedulerError,
	logJobSchedulerEvent,
	schedulerErrorFields,
	type SchedulerJobOutcomeLog,
} from './scheduler-logging.ts'

export { getJob, getJobInspection, inspectJobsForUser, listJobs }

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
		throw new McpCallerError('Jobs require a non-empty name.')
	}
	return trimmed
}

function normalizeJobCode(code: string) {
	const trimmed = code.trim()
	if (!trimmed) {
		throw new McpCallerError('Jobs require non-empty code.')
	}
	if (!hasTopLevelDefaultExport(trimmed)) {
		// Caller-supplied module shape mistake — keep it off Sentry via
		// McpCallerError so agent retries do not open platform bug issues.
		throw new McpCallerError(repoBackedModuleEntrypointExportErrorMessage)
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
	rootPackageId?: string | null
}) {
	assertPublishedSourceCanRebuildWithoutInstallingDeps({
		sourceFiles: input.sourceFiles,
		bundleLabel: `Saved package job "${normalizePackageWorkspacePath(
			input.entryPoint,
		)}"`,
	})
	// Load the worker bundler lazily so registry-only/node test paths that import
	// jobs/service.ts do not eagerly pull the heavy bundler stack.
	const { buildKodyModuleBundle } =
		await import('#worker/package-runtime/module-graph.ts')
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
		sourceId: string
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
		rootPackageId: input.packageContext?.packageId ?? null,
	})
	const artifact: PublishedBundleArtifact = {
		version: 1,
		kind: 'job',
		artifactName: input.artifactName ?? null,
		sourceId: input.sourceId,
		publishedCommit: source.published_commit,
		entryPoint: input.entryPoint,
		mainModule: bundle.mainModule,
		modules: bundle.modules,
		dependencies: bundle.dependencies,
		dynamicDependencies: bundle.dynamicDependencies ?? [],
		packageContext: input.packageContext ?? null,
		serviceContext: null,
		createdAt: new Date().toISOString(),
	}
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
		dynamicDependencies: bundle.dynamicDependencies,
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
	return artifact
}

function isPublishedJobBundleCurrent(input: {
	artifact: PublishedBundleArtifact | null
	rowPublishedCommit?: string | null
	currentPublishedCommit: string | null
}) {
	return (
		input.currentPublishedCommit != null &&
		input.artifact?.publishedCommit === input.currentPublishedCommit &&
		(input.rowPublishedCommit == null ||
			input.rowPublishedCommit === input.currentPublishedCommit)
	)
}

async function ensurePublishedBundleArtifactForJob(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
}) {
	const resolved = await resolvePublishedJobSource({
		env: input.env,
		userId: input.callerContext.user.userId,
		job: input.job,
	})
	const artifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.callerContext.user.userId,
		sourceId: input.job.sourceId,
		kind: 'job',
		artifactName: resolved.artifactName,
		entryPoint: resolved.entryPoint,
	})
	if (
		artifact?.artifact &&
		isPublishedJobBundleCurrent({
			artifact: artifact.artifact,
			rowPublishedCommit: artifact.row?.publishedCommit,
			currentPublishedCommit: resolved.source.published_commit,
		})
	) {
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
	if (resolved.packageContext) {
		const typecheckResult = await typecheckPackageEntrypointsFromSourceFiles({
			sourceFiles: resolved.files,
			entryPoints: [
				{
					path: resolved.entryPoint,
					includeStorage: true,
				},
			],
			emittedEventTopics: resolved.emittedEventTopics,
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
		sourceFiles: resolved.files,
		entryPoint: resolved.entryPoint,
		artifactName: resolved.artifactName,
		packageContext: resolved.packageContext,
	})
	const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.callerContext.user.userId,
		sourceId: input.job.sourceId,
		kind: 'job',
		artifactName: resolved.artifactName,
		entryPoint: resolved.entryPoint,
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
		sourceId: string
	} | null
	waitUntil?: (promise: Promise<unknown>) => void
	runRecordHandle?: RunRecordHandle | null
	idempotencyKey?: string | null
}) {
	if (!input.job.sourceId) {
		throw new Error('Repo-backed job source is missing.')
	}
	const artifact = await persistPublishedJobBundleArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		sourceId: input.job.sourceId,
		sourceFiles: input.sourceFiles,
		entryPoint: input.entryPoint,
		artifactName: input.artifactName,
		packageContext: input.packageContext ?? null,
	}).catch((error: unknown) => {
		throw markPreExecutionTransientError(error)
	})
	if (!artifact) {
		throw new Error(
			`Published bundle artifact for job "${input.job.id}" could not be persisted.`,
		)
	}
	return await executePublishedJobArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		artifact,
		bypassLogs: [],
		waitUntil: input.waitUntil,
		runRecordHandle: input.runRecordHandle,
		idempotencyKey: input.idempotencyKey,
	})
}

async function executePublishedJobArtifact(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
	artifact:
		| PublishedBundleArtifact
		| Awaited<ReturnType<typeof ensurePublishedBundleArtifactForJob>>
	bypassLogs: Array<string>
	waitUntil?: (promise: Promise<unknown>) => void
	runRecordHandle?: RunRecordHandle | null
	idempotencyKey?: string | null
}): Promise<ExecuteResult> {
	const source = await getEntitySourceById(
		input.env.APP_DB,
		input.job.sourceId,
	).catch((error: unknown) => {
		throw markPreExecutionTransientError(error)
	})
	const callerContext = {
		...input.callerContext,
		repoContext: source
			? {
					sourceId: source.id,
					repoId: source.repo_id,
					sessionId: null,
					baseCommit: source.published_commit,
					manifestPath: source.manifest_path,
					sourceRoot: source.source_root,
					publishedCommit: source.published_commit,
					entityKind: source.entity_kind,
					entityId: source.entity_id,
				}
			: null,
	}
	const packageContext = input.artifact.packageContext ?? null
	const runRecord = {
		surface: 'job' as const,
		name: input.job.name,
		jobId: input.job.id,
		storageId: input.job.storageId,
		sourceId: packageContext?.sourceId ?? input.job.sourceId,
		publishedCommit: source?.published_commit ?? input.job.publishedCommit,
		...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
		...(packageContext
			? {
					packageId: packageContext.packageId,
					kodyId: packageContext.kodyId,
				}
			: {}),
	}
	const packageRuntimeTools = packageContext
		? await (async () => {
				// Avoid a top-level jobs -> package-invocations cycle during capability
				// registry initialization.
				const { createPackageEventTools, createPackageRuntimeInvokeTools } =
					await import('#worker/package-invocations/service.ts')
				const sharedInput = {
					env: input.env,
					baseUrl: input.callerContext.baseUrl,
					callerContext,
					packageContext,
					parentRunRecord: runRecord,
					packageInvokeDepth: 0,
					waitUntil: input.waitUntil,
				}
				return {
					packageInvokeTools: createPackageRuntimeInvokeTools(sharedInput),
					packageEventTools: createPackageEventTools(sharedInput),
				}
			})()
		: null
	return await runBundledModuleWithRegistry(
		input.env,
		callerContext,
		{
			mainModule: input.artifact.mainModule,
			modules: input.artifact.modules,
			dependencies: input.artifact.dependencies,
		},
		input.job.params,
		{
			storageTools: {
				userId: input.callerContext.user.userId,
				storageId: input.job.storageId,
				writable: true,
			},
			...(packageContext ? { packageContext } : {}),
			runRecord,
			runRecordHandle: input.runRecordHandle,
			...(packageRuntimeTools ?? {}),
			waitUntil: input.runRecordHandle ? undefined : input.waitUntil,
		},
	).then((result) => ({
		...result,
		logs: [...input.bypassLogs, ...(result.logs ?? [])],
	}))
}

function buildPackageJobId(packageId: string, jobName: string) {
	return `package-job:${packageId}:${encodeURIComponent(jobName)}`
}

async function cleanupArchivedJobArtifacts(input: { env: Env; now?: Date }) {
	const due = await listArchivedJobArtifactsDueBefore(
		input.env.APP_DB,
		(input.now ?? new Date()).toISOString(),
	)
	for (const artifact of due) {
		try {
			const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
				id: artifact.sourceId,
				userId: artifact.userId,
			})
			if (
				source &&
				source.entity_kind === 'job' &&
				source.entity_id === artifact.jobId
			) {
				const artifactCleanup = await cleanupArtifactReposForSource({
					env: input.env,
					userId: artifact.userId,
					sourceId: source.id,
				})
				if (
					source.repo_id.trim() &&
					artifactCleanup.deleted === 0 &&
					!artifactCleanup.artifactAccessUnavailable
				) {
					throw new Error(
						`Artifact repo cleanup failed for source ${source.id}.`,
					)
				}
				await deleteRepoSessionsBySourceForUser(input.env.APP_DB, {
					userId: artifact.userId,
					sourceId: source.id,
				})
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

async function cleanupAdHocJobSource(input: {
	env: Env
	userId: string
	jobId: string
	sourceId: string | null | undefined
}) {
	if (!input.sourceId) {
		return
	}
	const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
		id: input.sourceId,
		userId: input.userId,
	})
	if (
		!source ||
		source.entity_kind !== 'job' ||
		source.entity_id !== input.jobId
	) {
		return
	}
	const artifactCleanup = await cleanupArtifactReposForSource({
		env: input.env,
		userId: input.userId,
		sourceId: source.id,
	})
	if (
		source.repo_id.trim() &&
		artifactCleanup.deleted === 0 &&
		!artifactCleanup.artifactAccessUnavailable
	) {
		throw new Error(`Artifact repo cleanup failed for source ${source.id}.`)
	}
	await deleteRepoSessionsBySourceForUser(input.env.APP_DB, {
		userId: input.userId,
		sourceId: source.id,
	})
	await deletePublishedArtifactsForSource({
		env: input.env,
		userId: input.userId,
		sourceId: source.id,
	})
	await deletePublishedSourceSnapshot({
		env: input.env,
		sourceId: source.id,
		publishedCommit: source.published_commit,
	})
	await deleteEntitySource(input.env.APP_DB, {
		id: source.id,
		userId: input.userId,
	})
}

function createPackageJobCallerContext(input: {
	baseUrl: string
	userId: string
	packageId: string
}): PersistedJobCallerContext {
	return createMcpCallerContext({
		baseUrl: input.baseUrl,
		executionOrigin: 'background',
		user: {
			userId: input.userId,
			email: '',
			username: undefined,
			displayName: `package:${input.packageId}`,
		},
		storageContext: {
			sessionId: null,
			appId: input.packageId,
			packageId: input.packageId,
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
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		async write() {
			const desiredJobs = input.manifest.kody.jobs ?? {}
			const existingRows = await listJobRowsByUserId(
				input.env.APP_DB,
				input.userId,
			)
			const packageRows = existingRows.filter(
				(row) => row.source_id === input.sourceId,
			)
			const existingByName = new Map(
				packageRows.map((row) => [row.name, row] as const),
			)
			const desiredNames = new Set(Object.keys(desiredJobs))
			const now = new Date().toISOString()
			let schedulerStateChanged = false

			for (const [jobName, definition] of Object.entries(desiredJobs)) {
				const existing = existingByName.get(jobName)
				const schedule = normalizeJobSchedule(definition.schedule)
				const timezone = normalizeJobTimezone(definition.timezone)
				const enabled = definition.enabled ?? true
				if (existing) {
					const schedulerStateMatches =
						JSON.stringify(existing.record.schedule) ===
							JSON.stringify(schedule) &&
						existing.record.timezone === timezone &&
						existing.record.enabled === enabled
					if (schedulerStateMatches) continue
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
						callerContextJson: serializeCallerContext(
							createPackageJobCallerContext({
								baseUrl: input.baseUrl,
								userId: input.userId,
								packageId: input.packageId,
							}),
						),
					})
					schedulerStateChanged = true
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
					preserved: false,
					expiresAt: null,
					createdAt: now,
					updatedAt: now,
					nextRunAt: computeNextRunAt({
						schedule,
						timezone,
					}),
					runCount: 0,
					successCount: 0,
					errorCount: 0,
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
				schedulerStateChanged = true
			}

			for (const row of packageRows) {
				if (desiredNames.has(row.name)) continue
				await deleteJobRow(input.env.APP_DB, input.userId, row.id)
				await deleteJobVector(input.env, row.id)
				schedulerStateChanged = true
			}
			return schedulerStateChanged
		},
	})
}

export async function deletePackageJobsForSourceId(input: {
	env: Env
	userId: string
	sourceId: string
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		async write() {
			const existingRows = await listJobRowsByUserId(
				input.env.APP_DB,
				input.userId,
			)
			for (const row of existingRows) {
				if (row.source_id !== input.sourceId) continue
				await deleteJobRow(input.env.APP_DB, input.userId, row.id)
				await deleteJobVector(input.env, row.id)
			}
		},
	})
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

function shouldSyncJobSourceForUpdate(body: JobUpdateInput) {
	return (
		body.code !== undefined ||
		body.name !== undefined ||
		body.schedule !== undefined ||
		body.timezone !== undefined ||
		body.sourceId !== undefined ||
		body.publishedCommit !== undefined
	)
}

export async function createJob(input: {
	env: Env
	callerContext: McpCallerContext
	body: JobCreateInput
}) {
	const callerContext = requirePersistableJobCallerContext(input.callerContext)
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: callerContext.user.userId,
		async write() {
			await assertWithinEntitlement({
				db: input.env.APP_DB,
				userId: callerContext.user.userId,
				email: callerContext.user.email,
				resource: 'scheduled_jobs',
			})
			const schedule = normalizeJobSchedule(input.body.schedule)
			const timezone = normalizeJobTimezone(input.body.timezone)
			const expiresAt = normalizeJobExpiresAt(input.body.expiresAt)
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
			const requestedEnabled = input.body.enabled ?? true
			const expiredAtCreate = isJobExpired({ expiresAt }, new Date(now))
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
				enabled: expiredAtCreate ? false : requestedEnabled,
				killSwitchEnabled: input.body.killSwitchEnabled ?? false,
				preserved: input.body.preserved ?? false,
				expiresAt,
				createdAt: now,
				updatedAt: now,
				nextRunAt: computeNextRunAt({
					schedule,
					timezone,
				}),
				runCount: 0,
				successCount: 0,
				errorCount: 0,
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
		},
	})
}

export async function updateJob(input: {
	env: Env
	callerContext: McpCallerContext
	body: JobUpdateInput
}) {
	const callerContext = requirePersistableJobCallerContext(input.callerContext)
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: callerContext.user.userId,
		async write() {
			const existingRow = await getJobRowById(
				input.env.APP_DB,
				callerContext.user.userId,
				input.body.id,
			)
			if (!existingRow) {
				throw new McpCallerError(`Job "${input.body.id}" was not found.`)
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
			const nextExpiresAt =
				input.body.expiresAt === undefined
					? (existing.expiresAt ?? null)
					: normalizeJobExpiresAt(input.body.expiresAt)
			const now = new Date()
			const nowIso = now.toISOString()
			const expired = isJobExpired({ expiresAt: nextExpiresAt }, now)
			const nextEnabled = expired
				? false
				: (input.body.enabled ?? existing.enabled)
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
				preserved: input.body.preserved ?? existing.preserved,
				expiresAt: nextExpiresAt,
				updatedAt: nowIso,
				nextRunAt: shouldRecomputeNextRunAt
					? computeNextRunAt({
							schedule: nextSchedule,
							timezone: nextTimezone,
						})
					: existing.nextRunAt,
			}
			if (shouldSyncJobSourceForUpdate(input.body)) {
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
			}
			const nextCallerContextJson = serializeCallerContext(callerContext)
			const didUpdate = await updateJobRow({
				db: input.env.APP_DB,
				userId: callerContext.user.userId,
				job: updated,
				callerContextJson: nextCallerContextJson,
			})
			if (!didUpdate) {
				throw new Error(`Job "${updated.id}" could not be updated.`)
			}
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
		},
	})
}

export async function deleteJob(input: {
	env: Env
	userId: string
	jobId: string
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		async write() {
			const row = await getJobRowById(
				input.env.APP_DB,
				input.userId,
				input.jobId,
			)
			if (!row) {
				throw new McpCallerError(`Job "${input.jobId}" was not found.`)
			}
			await cleanupAdHocJobSource({
				env: input.env,
				userId: input.userId,
				jobId: input.jobId,
				sourceId: row.record.sourceId,
			})
			const storageId = row.record.storageId
			await deleteJobRow(input.env.APP_DB, input.userId, input.jobId)
			await deleteJobVector(input.env, input.jobId)
			let storageCleared = false
			try {
				await storageRunnerRpc({
					env: input.env,
					userId: input.userId,
					storageId,
				}).clearStorage()
				storageCleared = true
			} catch (error) {
				logJobSchedulerError({
					event: 'job_storage_clear_failed',
					userId: input.userId,
					jobId: input.jobId,
					reason: 'job_delete',
					...schedulerErrorFields(error),
				})
			}
			// Keep the bucket registration when clear fails so storage_bytes
			// still accounts for orphaned DO data and a later sweep can retry.
			if (storageCleared) {
				try {
					await input.env.APP_DB.prepare(
						`DELETE FROM user_storage_buckets WHERE user_id = ? AND storage_id = ?`,
					)
						.bind(input.userId, storageId)
						.run()
				} catch (error) {
					logJobSchedulerError({
						event: 'job_storage_bucket_unregister_failed',
						userId: input.userId,
						jobId: input.jobId,
						reason: 'job_delete',
						...schedulerErrorFields(error),
					})
				}
			}
			await syncJobManagerAlarm({
				env: input.env,
				userId: input.userId,
			})
			return {
				id: input.jobId,
				deleted: true as const,
			}
		},
	})
}

export async function executeJobOnce(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext | null
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	waitUntil?: (promise: Promise<unknown>) => void
	runRecordHandle?: RunRecordHandle | null
	idempotencyKey?: string | null
}): Promise<JobExecutionOutcome> {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.job.userId,
		async write() {
			const started = new Date()
			let execution: JobExecutionResult
			let outcome: 'success' | 'error' = 'success'
			let finished = started
			let durationMs = 0
			let completedOccurrence = false
			try {
				if (!input.callerContext) {
					outcome = 'error'
					execution = {
						ok: false,
						error:
							'Job caller context is missing. Re-save the job to refresh its execution context.',
						logs: [],
					}
					completedOccurrence = true
				} else {
					const runtimeCallerContext: PersistedJobCallerContext = {
						...input.callerContext,
						executionOrigin: 'background',
						storageContext: {
							sessionId: input.callerContext.storageContext?.sessionId ?? null,
							appId: input.callerContext.storageContext?.appId ?? null,
							packageId: input.callerContext.storageContext?.packageId ?? null,
							storageId: input.job.storageId,
						},
						repoContext: input.callerContext.repoContext ?? null,
					}
					const result = await runRepoBackedJob({
						env: input.env,
						job: input.job,
						callerContext: runtimeCallerContext,
						repoCheckPolicyOverride: input.repoCheckPolicyOverride,
						waitUntil: input.waitUntil,
						runRecordHandle: input.runRecordHandle,
						idempotencyKey: input.idempotencyKey,
					})
					if (result.error) {
						outcome = 'error'
					}
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
					completedOccurrence = true
				}
			} catch (error) {
				if (error instanceof TransientJobExecutionError) {
					throw error
				}
				outcome = 'error'
				execution = {
					ok: false,
					error: formatJobError(error),
					logs: [],
				}
				completedOccurrence = true
			} finally {
				finished = new Date()
				durationMs = Math.max(0, finished.valueOf() - started.valueOf())
				const userId = input.job.userId
				if (userId && completedOccurrence) {
					await recordUsage(input.env, {
						userId,
						eventType: 'job_run',
						entityId: input.job.id,
						durationMs,
						outcome,
					})
				}
			}
			return {
				execution,
				startedAt: started.toISOString(),
				finishedAt: finished.toISOString(),
				durationMs,
			}
		},
	})
}

async function runRepoBackedJob(input: {
	env: Env
	job: JobRecord
	callerContext: PersistedJobCallerContext
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	waitUntil?: (promise: Promise<unknown>) => void
	runRecordHandle?: RunRecordHandle | null
	idempotencyKey?: string | null
}): Promise<ExecuteResult> {
	const resolved = await resolvePublishedJobSource({
		env: input.env,
		userId: input.callerContext.user.userId,
		job: input.job,
	}).catch((error: unknown) => {
		if (isTransientJobExecutionError(error)) {
			throw markPreExecutionTransientError(error)
		}
		return {
			error: formatJobError(error),
		}
	})
	if ('error' in resolved) {
		return {
			error: resolved.error,
			result: null,
			logs: [],
		}
	}
	const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.callerContext.user.userId,
		sourceId: input.job.sourceId,
		kind: 'job',
		artifactName: resolved.artifactName,
		entryPoint: resolved.entryPoint,
	}).catch((error: unknown) => {
		throw markPreExecutionTransientError(error)
	})
	if (
		loadedArtifact?.artifact &&
		isPublishedJobBundleCurrent({
			artifact: loadedArtifact.artifact,
			rowPublishedCommit: loadedArtifact.row?.publishedCommit,
			currentPublishedCommit: resolved.source.published_commit,
		})
	) {
		return await executePublishedJobArtifact({
			env: input.env,
			job: input.job,
			callerContext: input.callerContext,
			artifact: loadedArtifact.artifact,
			bypassLogs: [],
			waitUntil: input.waitUntil,
			runRecordHandle: input.runRecordHandle,
			idempotencyKey: input.idempotencyKey,
		})
	}
	return await rebuildAndExecuteJobArtifact({
		env: input.env,
		job: input.job,
		callerContext: input.callerContext,
		sourceFiles: resolved.files,
		entryPoint: resolved.entryPoint,
		artifactName: resolved.artifactName,
		packageContext: resolved.packageContext,
		waitUntil: input.waitUntil,
		runRecordHandle: input.runRecordHandle,
		idempotencyKey: input.idempotencyKey,
	})
}

export async function runJobNow(input: {
	env: Env
	userId: string
	jobId: string
	callerContext?: McpCallerContext | null
	repoCheckPolicyOverride?: JobRepoCheckPolicy | null
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		async write() {
			const row = await getJobRowById(
				input.env.APP_DB,
				input.userId,
				input.jobId,
			)
			if (!row) {
				throw new McpCallerError(`Job "${input.jobId}" was not found.`)
			}
			if (isJobExpired(row.record)) {
				throw new McpCallerError(
					`Job "${input.jobId}" expired at ${row.record.expiresAt} and cannot be run.`,
				)
			}
			const activeCallerContext = input.callerContext
				? requirePersistableJobCallerContext(input.callerContext)
				: row.callerContext
			const outcome = await executeJobOnce({
				env: input.env,
				job: row.record,
				callerContext: activeCallerContext,
				repoCheckPolicyOverride: input.repoCheckPolicyOverride,
				waitUntil: input.waitUntil,
			})
			const updated = applyExecutionOutcome(
				row.record,
				outcome,
				row.record.schedule.type === 'once'
					? { enabled: false }
					: {
							nextRunAt: computeNextRunAt({
								schedule: row.record.schedule,
								timezone: row.record.timezone,
								from: outcome.finishedAt,
							}),
						},
			)
			// Successful once jobs are retained for account/platform cleanup
			// rather than deleted immediately.
			const deletedAfterRun = false
			await updateJobRow({
				db: input.env.APP_DB,
				userId: input.userId,
				job: updated,
				callerContextJson: activeCallerContext
					? serializeCallerContext(activeCallerContext)
					: row.callerContextJson,
			})
			const job = await hydrateJobViewFromRunLog({
				env: input.env,
				userId: input.userId,
				job: toJobView(updated),
			})
			return {
				job,
				execution: outcome.execution,
				deletedAfterRun,
			}
		},
	})
}

async function executeClaimedScheduledJob(input: {
	env: Env
	row: NonNullable<Awaited<ReturnType<typeof claimJobRow>>>
	scheduledFor: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const idempotencyKey = buildScheduledJobIdempotencyKey({
		jobId: input.row.record.id,
		scheduledFor: input.scheduledFor,
	})
	const claim = await claimRunRecord({
		env: input.env,
		userId: input.row.record.userId,
		context: {
			surface: 'job',
			name: input.row.record.name,
			jobId: input.row.record.id,
			storageId: input.row.record.storageId,
			sourceId: input.row.record.sourceId,
			publishedCommit: input.row.record.publishedCommit,
			idempotencyKey,
			metadata: {
				scheduledFor: input.scheduledFor,
			},
		},
	})
	try {
		const outcome = await executeOrReplayScheduledJobRun({
			claim,
			execute: async (handle) =>
				executeJobOnce({
					env: input.env,
					job: input.row.record,
					callerContext: resolveScheduledJobCallerContext({
						rowUserId: input.row.record.userId,
						callerContext: input.row.callerContext,
					}),
					waitUntil: input.waitUntil,
					runRecordHandle: handle,
					idempotencyKey,
				}),
		})
		if (claim?.claimed) {
			const retained = await getRunRecord({
				env: input.env,
				userId: claim.handle.userId,
				runId: claim.handle.id,
			}).catch(() => null)
			if (!retained || retained.run.status === 'running') {
				await finishRunRecord({
					env: input.env,
					handle: claim.handle,
					status: outcome.execution.ok ? 'success' : 'error',
					logs: outcome.execution.logs,
					...(outcome.execution.ok
						? { result: outcome.execution.result }
						: { error: outcome.execution.error }),
				})
			}
		}
		return outcome
	} catch (error) {
		if (claim?.claimed && error instanceof TransientJobExecutionError) {
			await abandonRunRecord({
				env: input.env,
				handle: claim.handle,
			})
		}
		throw error
	}
}

export async function runDueJobsForUser(input: {
	env: Env
	userId: string
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		async write() {
			const now = input.now ?? new Date()
			const nowIso = now.toISOString()
			await disableExpiredJobRowsForUser({
				db: input.env.APP_DB,
				userId: input.userId,
				nowIso,
			})
			const dueRows = await listDueJobRows(
				input.env.APP_DB,
				input.userId,
				nowIso,
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
			let claimedJobCount = 0
			let successCount = 0
			let errorCount = 0
			const jobOutcomes: Array<SchedulerJobOutcomeLog> = []
			for (const dueRow of dueRows) {
				const claimToken = crypto.randomUUID()
				const claimNow = input.now ?? new Date()
				const row = await claimJobRow({
					db: input.env.APP_DB,
					userId: input.userId,
					jobId: dueRow.id,
					now: claimNow,
					claimToken,
				})
				if (!row?.claimed_scheduled_for) {
					continue
				}
				claimedJobCount += 1
				try {
					const outcome = await executeClaimedScheduledJob({
						env: input.env,
						row,
						scheduledFor: row.claimed_scheduled_for,
						waitUntil: input.waitUntil,
					})
					const result = await processDueJobs({
						jobs: [row.record],
						now,
						async executeJob() {
							return outcome
						},
					})
					const updated = result.saveJobs[0]
					if (!updated) {
						throw new Error(
							`Scheduled job "${row.id}" produced no final job state.`,
						)
					}
					const finalized = await finalizeClaimedJobRow({
						db: input.env.APP_DB,
						userId: input.userId,
						job: updated,
						callerContextJson: row.callerContextJson,
						claimToken,
						scheduledFor: row.claimed_scheduled_for,
					})
					if (!finalized) {
						// Ordinary edits clear claim_token; lease reclaim can
						// also supersede this runner. The fence worked — do not
						// fail the alarm or abort remaining due jobs.
						logJobSchedulerEvent({
							event: 'claim_lost_before_finalization',
							userId: input.userId,
							jobId: row.id,
							scheduleType: row.record.schedule.type,
							reason: 'fenced_claim_superseded',
						})
						continue
					}
					successCount += result.successCount
					errorCount += result.errorCount
					jobOutcomes.push(...result.jobOutcomes)
				} catch (error) {
					if (!(error instanceof TransientJobExecutionError)) {
						throw error
					}
					const retryAt = computeJobRetryAt({
						now: input.now ?? new Date(),
						retryCount: row.retry_count,
					})
					const retried = await retryClaimedJobRow({
						db: input.env.APP_DB,
						userId: input.userId,
						jobId: row.id,
						claimToken,
						nextRunAt: retryAt,
					})
					if (!retried) {
						logJobSchedulerEvent({
							event: 'claim_lost_before_retry_transition',
							userId: input.userId,
							jobId: row.id,
							scheduleType: row.record.schedule.type,
							reason: 'fenced_claim_superseded',
						})
						continue
					}
					errorCount += 1
					jobOutcomes.push({
						jobId: row.id,
						scheduleType: row.record.schedule.type,
						outcome: 'failure',
						nextRunAt: retryAt,
						deleted: false,
						error: error.message,
					})
				}
			}
			await cleanupArchivedJobArtifacts({
				env: input.env,
				now,
			})
			return {
				dueJobCount: claimedJobCount,
				successCount,
				errorCount,
				jobOutcomes,
			}
		},
	})
}

export async function getNextRunnableJob(input: {
	env: Env
	userId: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	await disableExpiredJobRowsForUser({
		db: input.env.APP_DB,
		userId: input.userId,
		nowIso,
	})
	const row = await getNextRunnableJobRow(
		input.env.APP_DB,
		input.userId,
		nowIso,
	)
	return row
		? {
				...row.record,
				nextRunAt: row.schedulerWakeAt,
			}
		: null
}
