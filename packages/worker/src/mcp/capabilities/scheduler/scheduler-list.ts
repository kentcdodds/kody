import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { schedulerList } from '#worker/scheduler/client.ts'
import {
	requireSchedulerUser,
	schedulerCapabilityKeywords,
	schedulerJobViewSchema,
} from './shared.ts'

export const schedulerListCapability = defineDomainCapability(
	capabilityDomainNames.scheduler,
	{
		name: 'scheduler_list',
		description:
			'List all scheduled jobs for the signed-in user, including next run time, last run status, and a human-readable schedule summary.',
		keywords: [...schedulerCapabilityKeywords],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.array(schedulerJobViewSchema),
		async handler(_args, ctx: CapabilityContext) {
			const user = requireSchedulerUser(ctx)
			return schedulerList(ctx.env, user.userId)
		},
	},
)
