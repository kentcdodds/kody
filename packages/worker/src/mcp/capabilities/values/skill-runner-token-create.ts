import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createSkillRunnerToken } from '#mcp/values/skill-runner-tokens.ts'

export const skillRunnerTokenCreateCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'skill_runner_token_create',
		description:
			'Create or rotate an external bearer token for the signed-in user by client name. The raw token is returned only from this call.',
		keywords: ['skill', 'runner', 'token', 'bearer', 'create', 'rotate'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			clientName: z
				.string()
				.min(1)
				.describe('External client name to store or rotate a token for.'),
		}),
		outputSchema: z.object({
			clientName: z.string(),
			token: z.string(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return {
				clientName: args.clientName.trim(),
				token: await createSkillRunnerToken({
					env: ctx.env,
					userId: user.userId,
					clientName: args.clientName,
				}),
			}
		},
	},
)
