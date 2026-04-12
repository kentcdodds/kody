import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { schedulerRunNow } from '#worker/scheduler/client.ts'
import {
	scheduledJobIdInputSchema,
	schedulerRunNowOutputSchema,
} from './shared.ts'

export const schedulerRunNowCapability = defineDomainCapability(
	capabilityDomainNames.scheduler,
	{
		name: 'scheduler_run_now',
		description:
			'Trigger a scheduled job immediately outside its normal schedule and return the execution result plus the updated job state.',
		keywords: ['schedule', 'run now', 'trigger', 'job'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: scheduledJobIdInputSchema,
		outputSchema: schedulerRunNowOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return schedulerRunNow(ctx.env, user.userId, {
				callerContext: ctx.callerContext,
				body: { id: args.id },
			})
		},
	},
)
