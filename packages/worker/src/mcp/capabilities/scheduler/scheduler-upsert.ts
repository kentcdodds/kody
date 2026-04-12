import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { schedulerCreate, schedulerUpdate } from '#worker/scheduler/client.ts'
import {
	requireSchedulerUser,
	schedulerJobViewSchema,
	schedulerUpsertInputSchema,
} from './shared.ts'

export const schedulerUpsertCapability = defineDomainCapability(
	capabilityDomainNames.scheduler,
	{
		name: 'scheduler_upsert',
		description:
			'Create a new scheduled codemode job when id is omitted, or update an existing scheduled job when id is provided. Supports one-shot UTC timestamps and recurring 5-field cron expressions with IANA timezone interpretation.',
		keywords: ['scheduler', 'upsert', 'create', 'update', 'cron', 'datetime'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: schedulerUpsertInputSchema,
		outputSchema: schedulerJobViewSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireSchedulerUser(ctx)
			if (args.id === undefined) {
				return schedulerCreate(ctx.env, user.userId, {
					callerContext: ctx.callerContext,
					body: {
						name: args.name ?? '',
						code: args.code ?? '',
						...(args.params !== undefined && args.params !== null
							? { params: args.params }
							: {}),
						schedule: args.schedule!,
						...(args.timezone !== undefined && args.timezone !== null
							? { timezone: args.timezone }
							: {}),
						...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
					},
				})
			}
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
