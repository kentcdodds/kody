import { exports as workerExports } from 'cloudflare:workers'
import { type ExecuteResult } from '@cloudflare/codemode'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { getMcpSkillByNameInput } from '#mcp/skills/mcp-skills-repo.ts'
import {
	applySkillParameters,
	parseSkillParameters,
} from '#mcp/skills/skill-parameters.ts'
import {
	getManifestTaskEntrypointPath,
	getManifestSourceRoot,
	parseRepoManifest,
} from '#worker/repo/manifest.ts'
import {
	buildRepoCodemodeBundle,
	createRepoCodemodeWrapper,
	getRepoSourceRelativePath,
	loadRepoSourceFilesFromSession,
} from '#worker/repo/repo-codemode-execution.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

const runFailureHint =
	'Open the saved skill source from its repo session, fix the module entrypoint, publish it, then run the skill again.'

export type SavedSkillRunResult = {
	ok: boolean
	result?: unknown
	error?: string
	logs: Array<string>
	hint?: string
}

function formatExecutionError(error: unknown): string {
	if (typeof error === 'string') return error
	if (error instanceof Error) return error.message
	return String(error)
}

export async function runSavedSkill(input: {
	env: Env
	callerContext: McpCallerContext
	name: string
	params?: Record<string, unknown>
}): Promise<SavedSkillRunResult> {
	const userId = input.callerContext.user?.userId
	if (!userId) {
		return {
			ok: false,
			error: 'Authenticated MCP user is required for this capability.',
			logs: [],
		} satisfies SavedSkillRunResult
	}

	const row = await getMcpSkillByNameInput(input.env.APP_DB, userId, input.name)
	if (!row) {
		return {
			ok: false,
			error: 'Skill not found for this user.',
			logs: [],
		} satisfies SavedSkillRunResult
	}

	const definitions = parseSkillParameters(row.parameters)
	const params = applySkillParameters({
		definitions,
		values: input.params,
	})
	const shouldPassParams = definitions != null || input.params !== undefined
	const exec = await runRepoBackedSkill({
		env: input.env,
		row,
		callerContext: input.callerContext,
		params: shouldPassParams ? params : undefined,
	})
	if (exec.error) {
		return {
			ok: false,
			error: formatExecutionError(exec.error),
			logs: exec.logs ?? [],
			hint: runFailureHint,
		} satisfies SavedSkillRunResult
	}

	return {
		ok: true,
		result: exec.result,
		logs: exec.logs ?? [],
	} satisfies SavedSkillRunResult
}

async function runRepoBackedSkill(input: {
	env: Env
	row: Awaited<ReturnType<typeof getMcpSkillByNameInput>>
	callerContext: McpCallerContext
	params?: Record<string, unknown>
}): Promise<ExecuteResult> {
	if (!input.row?.source_id) {
		return {
			result: undefined,
			error: 'Saved skill source is missing.',
			logs: [],
		}
	}
	const sessionId = `skill-runtime-${input.row.id}-${crypto.randomUUID()}`
	const sessionClient = repoSessionRpc(input.env, sessionId)
	const session = await sessionClient.openSession({
		sessionId,
		sourceId: input.row.source_id,
		userId: input.callerContext.user?.userId ?? '',
		baseUrl: input.callerContext.baseUrl,
		sourceRoot: '/',
	})
	try {
		const manifestPath =
			session.manifest_path?.replace(/^\/+/, '') || 'kody.json'
		const entrypoint = await sessionClient.readFile({
			sessionId: session.id,
			userId: input.callerContext.user?.userId ?? '',
			path: manifestPath,
		})
		if (!entrypoint.content) {
			return {
				result: undefined,
				error: `Skill manifest "${manifestPath}" was not found in repo session.`,
				logs: [],
			}
		}
		const manifest = parseRepoManifest({
			content: entrypoint.content,
			manifestPath,
		})
		const taskName =
			input.row.name?.trim() || manifest.tasks?.[0]?.name || 'default'
		const workspaceEntrypoint = getManifestTaskEntrypointPath(
			manifest,
			taskName,
		)
		const sourceRoot = getManifestSourceRoot(manifest)
		const moduleFile = await sessionClient.readFile({
			sessionId: session.id,
			userId: input.callerContext.user?.userId ?? '',
			path: workspaceEntrypoint,
		})
		if (!moduleFile.content) {
			return {
				result: undefined,
				error: `App task "${taskName}" was not found in repo session.`,
				logs: [],
			}
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
				input.row.source_id && session.published_commit
					? `${input.row.source_id}:${session.published_commit}`
					: null,
		})
		const { runCodemodeWithRegistry } =
			await import('#mcp/run-codemode-registry.ts')
		return runCodemodeWithRegistry(
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
					entityId: input.row.id,
				},
			},
			createRepoCodemodeWrapper({
				mainModule: bundle.mainModule,
			}),
			input.params,
			{
				executorExports: workerExports,
				executorModules: bundle.modules,
			},
		)
	} finally {
		await sessionClient
			.discardSession({
				sessionId: session.id,
				userId: input.callerContext.user?.userId ?? '',
			})
			.catch(() => {
				// Best effort only; preserve the original execution failure.
			})
	}
}
