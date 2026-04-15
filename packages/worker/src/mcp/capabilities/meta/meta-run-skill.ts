import { exports as workerExports } from 'cloudflare:workers'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getMcpSkillByNameInput } from '#mcp/skills/mcp-skills-repo.ts'
import {
	applySkillParameters,
	parseSkillParameters,
} from '#mcp/skills/skill-parameters.ts'
import { requireMcpUser } from './require-user.ts'

const runFailureHint =
	'If the saved codemode is wrong, use meta_get_skill to inspect it, then call meta_save_skill again with the same skill name to replace the stored code and metadata.'

const outputSchema = z.object({
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
	logs: z.array(z.string()).optional(),
	/** Present when ok is false; suggests how to fix stored skill code. */
	hint: z.string().optional(),
})

function formatExecutionError(error: unknown): string {
	if (typeof error === 'string') return error
	if (error instanceof Error) return error.message
	return String(error)
}

export const metaRunSkillCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_run_skill',
		description:
			'Execute a saved skill by name in the same sandbox as the MCP execute tool. Skill names are lower-kebab-case and unique per user. When the skill defines parameters, pass them in params; the code receives them via the params variable or the first function argument. Example: meta_run_skill({ "name": "github-pr-summary", "params": { "owner": "kentcdodds", "days": 3 } }). On failure, the structured result includes a hint for re-saving the skill with corrected code or metadata.',
		keywords: ['skill', 'run', 'execute'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			name: z
				.string()
				.min(1)
				.describe(
					'Unique lower-kebab-case skill name to execute for the signed-in user.',
				),
			params: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					'Optional parameter values for this skill (validated against saved definitions when present).',
				),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const row = await getMcpSkillByNameInput(
				ctx.env.APP_DB,
				user.userId,
				args.name,
			)
			if (!row) {
				throw new Error('Skill not found for this user.')
			}
			const definitions = parseSkillParameters(row.parameters)
			const params = applySkillParameters({
				definitions,
				values: args.params,
			})
			const shouldPassParams = definitions != null || args.params !== undefined
			const { runCodemodeWithRegistry } =
				await import('#mcp/run-codemode-registry.ts')
			const exec = await runCodemodeWithRegistry(
				ctx.env,
				ctx.callerContext,
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
				}
			}
			return {
				ok: true,
				result: exec.result,
				logs: exec.logs ?? [],
			}
		},
	},
)
