import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { deleteMcpSkill } from '#mcp/skills/mcp-skills-repo.ts'
import { deleteSkillVector } from '#mcp/skills/skill-vectorize.ts'
import { requireMcpUser } from './require-user.ts'

const outputSchema = z.object({
	deleted: z.boolean(),
})

export const metaDeleteSkillCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'meta_delete_skill',
		description: 'Delete a saved skill owned by the signed-in user.',
		keywords: ['skill', 'delete', 'remove'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			skill_id: z
				.string()
				.min(1)
				.describe('Skill id returned by meta_save_skill.'),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const removed = await deleteMcpSkill(
				ctx.env.APP_DB,
				user.userId,
				args.skill_id,
			)
			if (removed) {
				await deleteSkillVector(ctx.env, args.skill_id)
			}
			return { deleted: removed }
		},
	},
)
