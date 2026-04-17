import { exports as workerExports } from 'cloudflare:workers'
import { type ExecuteResult } from '@cloudflare/codemode'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { getMcpSkillByNameInput } from '#mcp/skills/mcp-skills-repo.ts'
import {
	applySkillParameters,
	parseSkillParameters,
} from '#mcp/skills/skill-parameters.ts'
import { repoSessionRpc } from '#worker/repo/repo-session-do.ts'

const runFailureHint =
	'If the saved codemode is wrong, use meta_get_skill to inspect it, then call meta_save_skill again with the same skill name to replace the stored code and metadata.'

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
	const { runCodemodeWithRegistry } =
		await import('#mcp/run-codemode-registry.ts')
	const exec =
		row.source_id != null
			? await runRepoBackedSkill({
					env: input.env,
					row,
					callerContext: input.callerContext,
					params: shouldPassParams ? params : undefined,
				})
			: await runCodemodeWithRegistry(
					input.env,
					input.callerContext,
					row.code,
					shouldPassParams ? params : undefined,
					{
						executorExports: workerExports,
					},
				)
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
			error: 'Repo-backed skill source is missing.',
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
			path: manifestPath,
		})
		if (!entrypoint.content) {
			return {
				result: undefined,
				error: `Skill manifest "${manifestPath}" was not found in repo session.`,
				logs: [],
			}
		}
		const { parseRepoManifest } = await import('#worker/repo/manifest.ts')
		const manifest = parseRepoManifest({
			content: entrypoint.content,
			manifestPath,
		})
		if (manifest.kind !== 'skill') {
			return {
				result: undefined,
				error: `Repo source "${input.row.source_id}" is not a skill manifest.`,
				logs: [],
			}
		}
		const moduleFile = await sessionClient.readFile({
			sessionId: session.id,
			path: manifest.entrypoint.replace(/^\/+/, ''),
		})
		if (!moduleFile.content) {
			return {
				result: undefined,
				error: `Skill entrypoint "${manifest.entrypoint}" was not found in repo session.`,
				logs: [],
			}
		}
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
			moduleFile.content,
			input.params,
			{
				executorExports: workerExports,
			},
		)
	} finally {
		await sessionClient.discardSession({ sessionId: session.id }).catch(() => {
			// Best effort only; preserve the original execution failure.
		})
	}
}
