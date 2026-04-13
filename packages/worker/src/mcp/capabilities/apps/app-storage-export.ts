import { z } from 'zod'
import {
	exportSavedAppRunnerStorage,
	syncSavedAppRunnerFromDb,
} from '#mcp/app-runner.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'

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
		truncated: z.boolean(),
		nextStartAfter: z.string().nullable(),
		pageSize: z.number(),
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
			page_size: z
				.number()
				.int()
				.min(1)
				.max(1_000)
				.optional()
				.describe('Optional page size for large storage exports.'),
			start_after: z
				.string()
				.min(1)
				.optional()
				.describe('Optional storage key to continue after from a prior page.'),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const artifact = await syncSavedAppRunnerFromDb({
				env: ctx.env,
				appId: args.app_id,
				userId: user.userId,
				baseUrl: ctx.callerContext.baseUrl,
			})
			if (!artifact) {
				throw new Error('Saved app not found for this user.')
			}
			const result = await exportSavedAppRunnerStorage({
				env: ctx.env,
				appId: args.app_id,
				facetName: args.facet_name,
				pageSize: args.page_size,
				startAfter: args.start_after,
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
