import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { getApp } from '#worker/apps/service.ts'
import { appGetInputSchema, appViewSchema } from './shared.ts'

export const appGetCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'app_get',
		description:
			'Load one saved app by app id, including its tasks, jobs, client/server flags, and metadata.',
		keywords: ['app', 'get', 'read', 'tasks', 'jobs'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: appGetInputSchema,
		outputSchema: appViewSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			return getApp({
				env: ctx.env,
				userId: user.userId,
				appId: args.app_id,
			})
		},
	},
)
