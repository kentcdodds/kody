import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { deleteAllAppScopedSecrets } from '#mcp/secrets/service.ts'
import { deleteAllAppScopedValues } from '#mcp/values/service.ts'
import { deleteSavedAppRunner } from '#mcp/app-runner.ts'
import { deleteUiArtifact, getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { deleteUiArtifactVector } from '#mcp/ui-artifacts-vectorize.ts'

const outputSchema = z.object({
	ok: z.literal(true),
	app_id: z.string(),
	deleted: z.boolean(),
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
			const app = await getUiArtifactById(
				ctx.env.APP_DB,
				user.userId,
				args.app_id,
			)
			if (!app) {
				return {
					ok: true,
					app_id: args.app_id,
					deleted: false,
				} as const
			}
			const cleanupResults = await Promise.allSettled([
				deleteSavedAppRunner({
					env: ctx.env,
					appId: args.app_id,
				}),
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
				deleteUiArtifactVector(ctx.env, args.app_id),
			])
			const cleanupErrors = cleanupResults
				.filter((result) => result.status === 'rejected')
				.map((result) =>
					result.reason instanceof Error
						? result.reason.message
						: String(result.reason),
				)
			if (cleanupErrors.length > 0) {
				throw new Error(
					`Saved app cleanup failed before deleting the record: ${cleanupErrors.join(
						'; ',
					)}`,
				)
			}
			const deleted = await deleteUiArtifact(
				ctx.env.APP_DB,
				user.userId,
				args.app_id,
			)
			if (!deleted) {
				console.warn('saved-app-delete-race', {
					appId: args.app_id,
					userId: user.userId,
				})
				return {
					ok: true,
					app_id: args.app_id,
					deleted: false,
				} as const
			}
			return {
				ok: true,
				app_id: args.app_id,
				deleted: true,
			} as const
		},
	},
)
