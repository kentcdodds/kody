import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { schedulerDelete } from '#worker/scheduler/client.ts'
import {
	scheduledJobIdInputSchema,
	schedulerDeleteOutputSchema,
} from './shared.ts'
import { requireMcpUser } from '../meta/require-user.ts'

export const schedulerDeleteCapability = defineDomainCapability(
	capabilityDomainNames.scheduler,
	{
		name: 'scheduler_delete',
		description:
			'Delete a scheduled job for the signed-in user by id and update the Durable Object alarm to the next pending run.',
		keywords: ['scheduler', 'delete', 'job', 'remove'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: scheduledJobIdInputSchema,
		outputSchema: schedulerDeleteOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return schedulerDelete(ctx.env, user.userId, args.id)
		},
	},
)
