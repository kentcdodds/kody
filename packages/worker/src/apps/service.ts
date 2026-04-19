import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { normalizeUiArtifactParameters } from '#mcp/ui-artifact-parameters.ts'
import { normalizeSkillParameters } from '#mcp/skills/skill-parameters.ts'
import { buildUiArtifactEmbedText } from '#mcp/ui-artifacts-embed.ts'
import {
	deleteUiArtifactVector,
	upsertUiArtifactVector,
} from '#mcp/ui-artifacts-vectorize.ts'
import {
	deleteSavedAppRunner,
	syncSavedAppRunnerFromDb,
	validateSavedAppRunner,
} from '#mcp/app-runner.ts'
import { runCodemodeWithRegistry } from '#mcp/run-codemode-registry.ts'
import { runJobNowViaManager, syncJobManagerAlarm } from '#worker/jobs/manager-do.ts'
import { syncArtifactSourceSnapshot } from '#worker/repo/source-sync.ts'
import {
	buildAppSourceFiles,
} from '#worker/repo/source-templates.ts'
import { ensureEntitySource } from '#worker/repo/source-service.ts'
import { updateEntitySource } from '#worker/repo/entity-sources.ts'
import {
	getManifestSourceRoot,
	getManifestTaskDefinition,
	getManifestTaskEntrypointPath,
	parseRepoManifest,
} from '#worker/repo/manifest.ts'
import {
	buildRepoCodemodeBundle,
	createRepoCodemodeWrapper,
	getRepoSourceRelativePath,
	loadRepoSourceFilesFromSession,
} from '#worker/repo/repo-codemode-execution.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'
import {
	processDueJobs,
} from '#worker/jobs/process-due-jobs.ts'
import {
	computeNextRunAt,
	formatScheduleSummary,
	normalizeJobSchedule,
	normalizeJobTimezone,
} from '#worker/jobs/schedule.ts'
import { createJobStorageId } from '#worker/storage-runner.ts'
import { exports as workerExports } from 'cloudflare:workers'
import {
	deleteAppRow,
	getAppRowById,
	insertAppRow,
	listAllApps,
	listAppRowsByUserId,
	updateAppRow,
} from './repo.ts'
import {
	type AppExecutionOutcome,
	type AppExecutionResult,
	type AppJobRecord,
	type AppRecord,
	type AppSaveInput,
	type AppTaskDefinition,
	type AppView,
	type PersistedAppCallerContext,
} from './types.ts'

const appTitleToTaskName = (title: string) =>
	title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')

function normalizeTaskName(input: string, fallbackTitle: string) {
	const candidate = input.trim() || appTitleToTaskName(fallbackTitle)
	if (!candidate) {
		throw new Error('App task name cannot be empty.')
	}
	return candidate
}

function requireAppUser(
	callerContext: McpCallerContext,
): PersistedAppCallerContext {
	if (!callerContext.user) {
		throw new Error('Authenticated MCP user is required for app operations.')
	}
	return callerContext as PersistedAppCallerContext
}

function normalizeKeywords(keywords: Array<string> | undefined) {
	return (keywords ?? []).map((keyword) => keyword.trim()).filter(Boolean)
}

function toAppView(app: AppRecord): AppView {
	const { userId: _userId, ...appView } = app
	return {
		...appView,
		jobCount: app.jobs.length,
		taskCount: app.tasks.length,
		scheduleSummary: app.jobs.map((job) =>
			formatScheduleSummary({
				schedule: job.schedule,
				timezone: job.timezone,
			}),
		),
	}
}

function normalizeTasks(
	tasks: NonNullable<AppSaveInput['tasks']> | undefined,
): Array<{
		definition: AppTaskDefinition
	source: NonNullable<Parameters<typeof buildAppSourceFiles>[0]['tasks']>[number]
	}> {
	return (tasks ?? []).map((task) => {
		const name = normalizeTaskName(task.name, task.title ?? task.name)
		const title = task.title?.trim() || task.name.trim() || name
		const description = task.description.trim()
		const parameters = normalizeSkillParameters(task.parameters)
		return {
			definition: {
				name,
				title,
				description,
				entrypoint: `src/tasks/${name}.ts`,
				keywords: normalizeKeywords(task.keywords),
				searchText: task.searchText ?? null,
				parameters,
				readOnly: task.readOnly ?? false,
				idempotent: task.idempotent ?? false,
				destructive: task.destructive ?? false,
				usesCapabilities: task.usesCapabilities ?? null,
			},
			source: {
				name,
				entrypoint: `src/tasks/${name}.ts`,
				code: task.code,
				title,
				description,
				keywords: normalizeKeywords(task.keywords),
				searchText: task.searchText ?? null,
				parameters,
				readOnly: task.readOnly ?? false,
				idempotent: task.idempotent ?? false,
				destructive: task.destructive ?? false,
				usesCapabilities: task.usesCapabilities ?? null,
			},
		}
	})
}

function normalizeJobs(input: {
	jobs: NonNullable<AppSaveInput['jobs']> | undefined
	existingJobs: Array<AppJobRecord>
	callerContext: PersistedAppCallerContext
	now: string
}) {
	const existingByName = new Map(
		input.existingJobs.map((job) => [job.name, job] as const),
	)
	return (input.jobs ?? []).map((job) => {
		const existing = existingByName.get(job.name)
		const schedule = normalizeJobSchedule(job.schedule)
		const timezone = normalizeJobTimezone(job.timezone)
		const createdAt = existing?.createdAt ?? input.now
		return {
			id: existing?.id ?? crypto.randomUUID(),
			name: job.name,
			title: job.title?.trim() || job.name,
			description: job.description?.trim() || job.name,
			task: normalizeTaskName(job.task, job.task),
			params: job.params,
			callerContext: existing?.callerContext ?? input.callerContext,
			schedule,
			timezone,
			enabled: job.enabled ?? existing?.enabled ?? true,
			killSwitchEnabled:
				job.killSwitchEnabled ?? existing?.killSwitchEnabled ?? false,
			storageId:
				job.storageId ?? existing?.storageId ?? createJobStorageId(existing?.id ?? crypto.randomUUID()),
			lastRunAt: existing?.lastRunAt,
			lastRunStatus: existing?.lastRunStatus,
			lastRunError: existing?.lastRunError,
			lastDurationMs: existing?.lastDurationMs,
			nextRunAt:
				existing?.nextRunAt ??
				computeNextRunAt({
					schedule,
					timezone,
				}),
			runCount: existing?.runCount ?? 0,
			successCount: existing?.successCount ?? 0,
			errorCount: existing?.errorCount ?? 0,
			runHistory: existing?.runHistory ?? [],
			createdAt,
			updatedAt: input.now,
		}
	})
}

function buildAppSearchEmbed(app: AppRecord) {
	const taskText = app.tasks.map((task) => ({
		name: task.name,
		description: task.description,
		type: 'task',
		required: false,
	}))
	return buildUiArtifactEmbedText({
		title: app.title,
		description: [
			app.description,
			taskText.length > 0
				? `Tasks: ${taskText.map((task) => task.name).join(', ')}`
				: '',
			app.jobs.length > 0
				? `Jobs: ${app.jobs.map((job) => job.name).join(', ')}`
				: '',
		]
			.filter(Boolean)
			.join('\n'),
		hasServerCode: app.hasServer,
		parameters: app.parameters,
	})
}

async function syncAppArtifacts(input: {
	env: Env
	userId: string
	baseUrl: string
	app: AppRecord
	clientCode: string | null
	serverCode: string | null
	taskSources: Array<NonNullable<Parameters<typeof buildAppSourceFiles>[0]['tasks']>[number]>
	bootstrapAccess: Awaited<ReturnType<typeof ensureEntitySource>>['bootstrapAccess']
}) {
	const syncedPublishedCommit = await syncArtifactSourceSnapshot({
		env: input.env,
		userId: input.userId,
		baseUrl: input.baseUrl,
		sourceId: input.app.sourceId,
		bootstrapAccess: input.bootstrapAccess ?? null,
		files: buildAppSourceFiles({
			title: input.app.title,
			description: input.app.description,
			keywords: input.app.keywords,
			searchText: input.app.searchText,
			parameters: input.app.parameters,
			hidden: input.app.hidden,
			clientCode: input.clientCode,
			serverCode: input.serverCode,
			tasks: input.taskSources,
			jobs: input.app.jobs.map((job) => ({
				name: job.name,
				title: job.title,
				description: job.description,
				task: job.task,
				params: job.params,
				schedule: job.schedule,
				timezone: job.timezone,
				enabled: job.enabled,
				killSwitchEnabled: job.killSwitchEnabled,
			})),
		}),
	})
	if (syncedPublishedCommit) {
		input.app.publishedCommit = syncedPublishedCommit
		await updateEntitySource(input.env.APP_DB, {
			id: input.app.sourceId,
			userId: input.userId,
			publishedCommit: syncedPublishedCommit,
			indexedCommit: syncedPublishedCommit,
		})
	}
}

export async function saveApp(input: {
	env: Env
	callerContext: McpCallerContext
	body: AppSaveInput
}) {
	const callerContext = requireAppUser(input.callerContext)
	const existing =
		input.body.appId == null
			? null
			: await getAppRowById(
					input.env.APP_DB,
					callerContext.user.userId,
					input.body.appId,
				)
	if (input.body.appId && !existing) {
		throw new Error('Saved app not found for this user.')
	}
	const appId = input.body.appId ?? crypto.randomUUID()
	const now = new Date().toISOString()
	const ensuredSource = await ensureEntitySource({
		db: input.env.APP_DB,
		env: input.env,
		userId: callerContext.user.userId,
		entityKind: 'app',
		entityId: appId,
		sourceRoot: '/',
		requirePersistence: true,
	})
	const taskSources = normalizeTasks(input.body.tasks)
	const tasks = taskSources.map((task) => task.definition)
	const jobs = normalizeJobs({
		jobs: input.body.jobs,
		existingJobs: existing?.jobs ?? [],
		callerContext,
		now,
	})
	const app: AppRecord = {
		version: 1,
		id: appId,
		userId: callerContext.user.userId,
		title: input.body.title.trim(),
		description: input.body.description.trim(),
		sourceId: ensuredSource.id,
		publishedCommit: existing?.publishedCommit ?? ensuredSource.published_commit ?? null,
		repoCheckPolicy: input.body.repoCheckPolicy ?? existing?.repoCheckPolicy,
		hidden: input.body.hidden ?? existing?.hidden ?? true,
		keywords: normalizeKeywords(input.body.keywords),
		searchText: input.body.searchText ?? null,
		parameters: normalizeUiArtifactParameters(input.body.parameters),
		hasClient: input.body.clientCode != null,
		hasServer: input.body.serverCode != null,
		tasks,
		jobs,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	}
	await syncAppArtifacts({
		env: input.env,
		userId: callerContext.user.userId,
		baseUrl: callerContext.baseUrl,
		app,
		clientCode: input.body.clientCode ?? null,
		serverCode: input.body.serverCode ?? null,
		taskSources: taskSources.map((task) => task.source),
		bootstrapAccess: ensuredSource.bootstrapAccess ?? null,
	})
	if (existing) {
		await updateAppRow(input.env.APP_DB, callerContext.user.userId, app)
	} else {
		await insertAppRow(input.env.APP_DB, app)
	}
	if (app.hasClient || app.hasServer) {
		await syncSavedAppRunnerFromDb({
			env: input.env,
			appId,
			userId: callerContext.user.userId,
			baseUrl: callerContext.baseUrl,
		})
		await validateSavedAppRunner({
			env: input.env,
			appId,
		})
	} else {
		await deleteSavedAppRunner({
			env: input.env,
			appId,
		}).catch(() => {
			// Best effort only.
		})
	}
	if (!app.hidden) {
		await upsertUiArtifactVector(input.env, {
			appId,
			userId: callerContext.user.userId,
			embedText: buildAppSearchEmbed(app),
		})
	} else {
		await deleteUiArtifactVector(input.env, appId)
	}
	await syncJobManagerAlarm({
		env: input.env,
		userId: callerContext.user.userId,
	}).catch(() => {
		// Best effort only.
	})
	return toAppView(app)
}

export async function listApps(input: { env: Env; userId: string }) {
	const rows = await listAppRowsByUserId(input.env.APP_DB, input.userId)
	return rows.map(toAppView)
}

export async function getApp(input: { env: Env; userId: string; appId: string }) {
	const row = await getAppRowById(input.env.APP_DB, input.userId, input.appId)
	if (!row) {
		throw new Error(`App "${input.appId}" was not found.`)
	}
	return toAppView(row)
}

export async function deleteApp(input: {
	env: Env
	userId: string
	appId: string
}) {
	await deleteSavedAppRunner({
		env: input.env,
		appId: input.appId,
	}).catch(() => {
		// Best effort only.
	})
	await deleteUiArtifactVector(input.env, input.appId).catch(() => {
		// Best effort only.
	})
	return {
		id: input.appId,
		deleted: await deleteAppRow(input.env.APP_DB, input.userId, input.appId),
	}
}

async function executeAppTaskInternal(input: {
	env: Env
	callerContext: McpCallerContext
	app: AppRecord
	taskName: string
	params?: Record<string, unknown>
	storageId?: string | null
}): Promise<AppExecutionResult> {
	const sessionId = `app-task-runtime-${input.app.id}-${crypto.randomUUID()}`
	const sessionClient = repoSessionRpc(input.env, sessionId)
	const session = await sessionClient.openSession({
		sessionId,
		sourceId: input.app.sourceId,
		userId: input.callerContext.user?.userId ?? '',
		baseUrl: input.callerContext.baseUrl,
		sourceRoot: '/',
	})
	try {
		const manifestPath =
			session.manifest_path?.replace(/^\/+/, '') || 'kody.json'
		const manifestFile = await sessionClient.readFile({
			sessionId: session.id,
			userId: input.callerContext.user?.userId ?? '',
			path: manifestPath,
		})
		if (!manifestFile.content) {
			return buildAppExecutionResult({
				ok: false,
				error: `App manifest "${manifestPath}" was not found in repo session.`,
			})
		}
		const manifest = parseRepoManifest({
			content: manifestFile.content,
			manifestPath,
		})
		const taskDefinition = getManifestTaskDefinition(manifest, input.taskName)
		const sourceRoot = getManifestSourceRoot(manifest)
		const workspaceEntrypoint = getManifestTaskEntrypointPath(
			manifest,
			input.taskName,
		)
		const moduleFile = await sessionClient.readFile({
			sessionId: session.id,
			userId: input.callerContext.user?.userId ?? '',
			path: workspaceEntrypoint,
		})
		if (!moduleFile.content) {
			return buildAppExecutionResult({
				ok: false,
				error: `App task "${taskDefinition.name}" entrypoint was not found in repo session.`,
			})
		}
		const sourceFiles = await loadRepoSourceFilesFromSession({
			sessionClient,
			sessionId: session.id,
			userId: input.callerContext.user?.userId ?? '',
			sourceRoot,
		})
		const bundle = await buildRepoCodemodeBundle({
			sourceFiles,
			entryPoint: getRepoSourceRelativePath(workspaceEntrypoint, sourceRoot),
			entryPointSource: moduleFile.content,
			sourceRoot,
			cacheKey:
				input.app.sourceId && session.published_commit
					? `${input.app.sourceId}:${taskDefinition.name}:${session.published_commit}`
					: null,
		})
		const result = await runCodemodeWithRegistry(
			input.env,
			{
				...input.callerContext,
				storageContext: {
					sessionId: input.callerContext.storageContext?.sessionId ?? null,
					appId: input.app.id,
					storageId: input.storageId ?? null,
				},
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
					entityId: input.app.id,
				},
			},
			createRepoCodemodeWrapper({
				mainModule: bundle.mainModule,
				includeStorage: input.storageId != null,
			}),
			input.params,
			{
				executorExports: workerExports,
				executorModules: bundle.modules,
				...(input.storageId != null
					? {
							storageTools: {
								userId: input.callerContext.user?.userId ?? '',
								storageId: input.storageId,
								writable: true,
							},
						}
					: {}),
			},
		)
		return result.error
			? buildAppExecutionResult({
					ok: false,
					error: String(result.error),
					logs: result.logs ?? [],
				})
			: buildAppExecutionResult({
					ok: true,
					result: result.result,
					logs: result.logs ?? [],
				})
	} finally {
		await sessionClient
			.discardSession({
				sessionId: session.id,
				userId: input.callerContext.user?.userId ?? '',
			})
			.catch(() => {
				// Best effort only.
			})
	}
}

export async function runAppTask(input: {
	env: Env
	callerContext: McpCallerContext
	appId: string
	taskName: string
	params?: Record<string, unknown>
}) {
	const callerContext = requireAppUser(input.callerContext)
	const app = await getAppRowById(
		input.env.APP_DB,
		callerContext.user.userId,
		input.appId,
	)
	if (!app) {
		throw new Error(`App "${input.appId}" was not found.`)
	}
	const task = app.tasks.find((candidate) => candidate.name === input.taskName.trim())
	if (!task) {
		throw new Error(`App "${input.appId}" does not define a task named "${input.taskName}".`)
	}
	return executeAppTaskInternal({
		env: input.env,
		callerContext,
		app,
		taskName: task.name,
		params: input.params,
	})
}

export async function runAppJob(input: {
	env: Env
	callerContext: McpCallerContext
	appId: string
	jobName?: string
	jobId?: string
}) {
	const callerContext = requireAppUser(input.callerContext)
	const app = await getAppRowById(
		input.env.APP_DB,
		callerContext.user.userId,
		input.appId,
	)
	if (!app) {
		throw new Error(`App "${input.appId}" was not found.`)
	}
	const job =
		input.jobId != null
			? app.jobs.find((candidate) => candidate.id === input.jobId)
			: app.jobs.find((candidate) => candidate.name === input.jobName?.trim())
	if (!job) {
		throw new Error(
			`App "${input.appId}" does not define the requested job.`,
		)
	}
	return runJobNowViaManager({
		env: input.env,
		userId: callerContext.user.userId,
		jobId: job.id,
		callerContext,
	})
}

export function buildAppExecutionResult(input: {
	ok: boolean
	result?: unknown
	error?: string
	logs?: Array<string>
}): AppExecutionResult {
	if (input.ok) {
		return {
			ok: true,
			result: input.result,
			logs: input.logs ?? [],
		}
	}
	return {
		ok: false,
		error: input.error ?? 'Unknown app execution error.',
		logs: input.logs ?? [],
	}
}
