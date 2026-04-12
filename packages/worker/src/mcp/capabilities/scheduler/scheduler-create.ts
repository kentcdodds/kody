import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { schedulerCreate } from '#worker/scheduler/client.ts'
import { schedulerCreateInputSchema, schedulerJobViewSchema } from './shared.ts'

export const schedulerCreateCapability = defineDomainCapability(
	capabilityDomainNames.scheduler,
	{
		name: 'scheduler_create',
		description:
			'Create a scheduled codemode job for the signed-in user. Supports one-shot UTC timestamps or recurring 5-field cron expressions with IANA timezone interpretation.',
		keywords: ['schedule', 'cron', 'datetime', 'job', 'automation'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: schedulerCreateInputSchema,
		outputSchema: schedulerJobViewSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return schedulerCreate(ctx.env, user.userId, {
				callerContext: ctx.callerContext,
				body: args,
			})
		},
	},
)
