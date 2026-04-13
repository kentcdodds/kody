import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { deleteSavedAppRunner } from '#mcp/app-runner.ts'
import { deleteUiArtifact } from '#mcp/ui-artifacts-repo.ts'
import { deleteUiArtifactVector } from '#mcp/ui-artifacts-vectorize.ts'

const outputSchema = z.object({
	ok: z.literal(true),
	app_id: z.string(),
	deleted: z.literal(true),
})

export const appDeleteCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'app_delete',
		description:
			'Delete a saved app record and all known facet storage for that app.',
		keywords: ['app', 'delete', 'facet', 'storage', 'saved app'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			app_id: z.string().min(1),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			await deleteUiArtifact(ctx.env.APP_DB, user.userId, args.app_id)
			await Promise.allSettled([
				deleteUiArtifactVector(ctx.env, args.app_id),
				deleteSavedAppRunner({
					env: ctx.env,
					appId: args.app_id,
				}),
			])
			return {
				ok: true,
				app_id: args.app_id,
				deleted: true,
			} as const
		},
	},
)
