import { z } from 'zod'
import { exportSavedAppRunnerStorage } from '#mcp/app-runner.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'

const outputSchema = z.object({
	ok: z.literal(true),
	app_id: z.string(),
	facet_name: z.string(),
	export: z.object({
		entries: z.array(
			z.object({
				key: z.string(),
				value: z.unknown(),
			}),
		),
		estimatedBytes: z.number(),
	}),
})

export const appStorageExportCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'app_storage_export',
		description:
			'Export one saved app facet storage database as JSON for debugging or migrations.',
		keywords: ['app', 'facet', 'storage', 'export', 'sqlite'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			app_id: z.string().min(1),
			facet_name: z
				.string()
				.min(1)
				.optional()
				.describe('Optional facet name. Defaults to `main`.'),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const artifact = await getUiArtifactById(
				ctx.env.APP_DB,
				user.userId,
				args.app_id,
			)
			if (!artifact) {
				throw new Error('Saved app not found for this user.')
			}
			const result = await exportSavedAppRunnerStorage({
				env: ctx.env,
				appId: args.app_id,
				facetName: args.facet_name,
			})
			return {
				ok: true as const,
				app_id: result.appId,
				facet_name: result.facetName,
				export: result.export,
			}
		},
	},
)
