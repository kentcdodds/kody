import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { schedulerUpdate } from '#worker/scheduler/client.ts'
import {
	requireSchedulerUser,
	schedulerJobViewSchema,
	schedulerUpdateInputSchema,
} from './shared.ts'

export const schedulerUpdateCapability = defineDomainCapability(
	capabilityDomainNames.scheduler,
	{
		name: 'scheduler_update',
		description:
			'Update a scheduled codemode job by id. You can change the name, code, params, schedule, timezone, or enabled flag. Changing the schedule recomputes nextRunAt immediately.',
		keywords: ['scheduler', 'update', 'cron', 'datetime', 'job'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: schedulerUpdateInputSchema,
		outputSchema: schedulerJobViewSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireSchedulerUser(ctx)
			return schedulerUpdate(ctx.env, user.userId, {
				callerContext: ctx.callerContext,
				body: {
					id: args.id,
					...(args.name !== undefined ? { name: args.name } : {}),
					...(args.code !== undefined ? { code: args.code } : {}),
					...(args.params !== undefined ? { params: args.params } : {}),
					...(args.schedule !== undefined ? { schedule: args.schedule } : {}),
					...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
					...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
				},
			})
		},
	},
)
