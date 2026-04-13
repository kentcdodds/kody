import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { appRunnerRpc, syncSavedAppRunnerFromDb } from '#mcp/app-runner.ts'

const inputSchema = z.object({
	app_id: z.string().min(1).describe('Saved app id to reset.'),
	facet_name: z
		.string()
		.min(1)
		.optional()
		.describe('Optional facet name. Defaults to `main`.'),
})

const outputSchema = z.object({
	ok: z.literal(true),
	app_id: z.string(),
	facet_name: z.string(),
})

export const appStorageResetCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'app_storage_reset',
		description:
			'Delete all SQLite-backed storage for one saved app facet while keeping the saved app record itself.',
		keywords: ['app', 'storage', 'reset', 'facet', 'sqlite'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const app = await syncSavedAppRunnerFromDb({
				env: ctx.env,
				appId: args.app_id,
				userId: user.userId,
			})
			if (!app) {
				throw new Error('Saved app not found for this user.')
			}
			const result = await appRunnerRpc(ctx.env, args.app_id).resetStorage({
				appId: args.app_id,
				facetName: args.facet_name ?? 'main',
			})
			return {
				ok: true as const,
				app_id: result.appId,
				facet_name: result.facetName,
			}
		},
	},
)
