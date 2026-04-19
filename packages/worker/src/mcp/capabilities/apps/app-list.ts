import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { listApps } from '#worker/apps/service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { appViewSchema } from './shared.ts'

const outputSchema = z.object({
	apps: z.array(appViewSchema),
})

export const appListCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'app_list',
		description:
			'List the signed-in user’s saved apps, including task/job counts and schedule summaries.',
		keywords: ['app', 'list', 'tasks', 'jobs', 'server', 'client'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return {
				apps: await listApps({
					env: ctx.env,
					userId: user.userId,
				}),
			}
		},
	},
)
