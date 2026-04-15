import { exports as workerExports } from 'cloudflare:workers'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { getMcpSkillByNameInput } from '#mcp/skills/mcp-skills-repo.ts'
import {
	applySkillParameters,
	parseSkillParameters,
} from '#mcp/skills/skill-parameters.ts'

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
	const exec = await runCodemodeWithRegistry(
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
