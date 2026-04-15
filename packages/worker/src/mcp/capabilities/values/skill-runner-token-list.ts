import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { listSkillRunnerTokens } from '#mcp/values/skill-runner-tokens.ts'

export const skillRunnerTokenListCapability = defineDomainCapability(
	capabilityDomainNames.values,
	{
		name: 'skill_runner_token_list',
		description:
			'List external bearer tokens for the signed-in user with token values redacted, including human-friendly names, optional descriptions, and last-used timestamps.',
		keywords: ['skill', 'runner', 'token', 'bearer', 'list', 'redacted'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			tokens: z.array(
				z.object({
					clientName: z.string(),
					name: z.string(),
					description: z.string().nullable(),
					lastUsedAt: z.string().nullable(),
					token: z.string(),
				}),
			),
		}),
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return {
				tokens: await listSkillRunnerTokens({
					env: ctx.env,
					userId: user.userId,
				}),
			}
		},
	},
)
