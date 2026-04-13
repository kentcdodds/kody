import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { deleteSavedAppRunner } from '#mcp/app-runner.ts'
import { deleteAllAppScopedSecrets } from '#mcp/secrets/service.ts'
import { deleteUiArtifact } from '#mcp/ui-artifacts-repo.ts'
import { deleteUiArtifactVector } from '#mcp/ui-artifacts-vectorize.ts'
import { deleteAllAppScopedValues } from '#mcp/values/service.ts'

const outputSchema = z.object({
	deleted: z.boolean(),
	app_id: z.string(),
})

export const uiDeleteAppCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'ui_delete_app',
		description: 'Delete a saved UI artifact owned by the signed-in user.',
		keywords: ['ui', 'app', 'artifact', 'delete', 'remove'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			app_id: z
				.string()
				.min(1)
				.describe('Saved UI artifact id returned by ui_save_app.'),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const removed = await deleteUiArtifact(
				ctx.env.APP_DB,
				user.userId,
				args.app_id,
			)
			if (removed) {
				await Promise.allSettled([
					deleteUiArtifactVector(ctx.env, args.app_id),
					deleteAllAppScopedSecrets({
						env: ctx.env,
						userId: user.userId,
						appId: args.app_id,
					}),
					deleteAllAppScopedValues({
						env: ctx.env,
						userId: user.userId,
						appId: args.app_id,
					}),
					deleteSavedAppRunner({
						env: ctx.env,
						appId: args.app_id,
					}),
				])
			}
			return { deleted: removed, app_id: args.app_id }
		},
	},
)
