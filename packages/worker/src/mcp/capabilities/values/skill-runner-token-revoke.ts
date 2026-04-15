import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { revokeSkillRunnerToken } from '#mcp/values/skill-runner-tokens.ts'

export const skillRunnerTokenRevokeCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'skill_runner_token_revoke',
		description:
			'Delete an external bearer token for the signed-in user by client name.',
		keywords: ['skill', 'runner', 'token', 'bearer', 'revoke', 'delete'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			clientName: z
				.string()
				.min(1)
				.describe('External client name whose token should be removed.'),
		}),
		outputSchema: z.object({
			clientName: z.string(),
			revoked: z.boolean(),
		}),
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return {
				clientName: args.clientName.trim(),
				revoked: await revokeSkillRunnerToken({
					env: ctx.env,
					userId: user.userId,
					clientName: args.clientName,
				}),
			}
		},
	},
)
