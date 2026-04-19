import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { saveApp } from '#worker/apps/service.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { appSaveInputSchema, appViewSchema } from './shared.ts'

export const appSaveCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'app_save',
		description:
			'Create or replace a saved app package for the signed-in user. An app can contain client UI, server code, multiple named tasks, and multiple scheduled jobs.',
		keywords: ['app', 'save', 'tasks', 'jobs', 'server', 'client', 'package'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: appSaveInputSchema,
		outputSchema: appViewSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			return saveApp({
				env: ctx.env,
				callerContext: ctx.callerContext,
				body: {
					appId: args.app_id,
					title: args.title,
					description: args.description,
					hidden: args.hidden,
					keywords: args.keywords,
					searchText: args.searchText,
					parameters: args.parameters,
					clientCode: args.clientCode,
					serverCode: args.serverCode,
					tasks: args.tasks,
					jobs: args.jobs,
					repoCheckPolicy: args.repoCheckPolicy,
				},
			})
		},
	},
)
