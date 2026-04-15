import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { runSavedSkill } from '#mcp/skills/run-saved-skill.ts'

const outputSchema = z.object({
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
	logs: z.array(z.string()).optional(),
	/** Present when ok is false; suggests how to fix stored skill code. */
	hint: z.string().optional(),
})

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
			return runSavedSkill({
				env: ctx.env,
				callerContext: ctx.callerContext,
				name: args.name,
				params: args.params,
			})
		},
	},
)
