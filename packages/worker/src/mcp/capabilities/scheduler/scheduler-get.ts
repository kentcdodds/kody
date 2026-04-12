import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { schedulerGet } from '#worker/scheduler/client.ts'
import { scheduledJobIdInputSchema, schedulerJobViewSchema } from './shared.ts'

export const schedulerGetCapability = defineDomainCapability(
	capabilityDomainNames.scheduler,
	{
		name: 'scheduler_get',
		description:
			'Get one scheduled codemode job by id for the signed-in user, including next run time and last execution state.',
		keywords: ['schedule', 'scheduler', 'job', 'get'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: scheduledJobIdInputSchema,
		outputSchema: schedulerJobViewSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			return schedulerGet(ctx.env, user.userId, args.id)
		},
	},
)
