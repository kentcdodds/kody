import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { storageExportOutputSchema, storageIdSchema, requireStorageUser } from './shared.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'

export const storageExportCapability = defineDomainCapability(
	capabilityDomainNames.storage,
	{
		name: 'storage_export',
		description:
			'Export one durable storage bucket as JSON for inspection, debugging, or comparisons.',
		keywords: ['storage', 'export', 'sqlite', 'durable object'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: storageIdSchema.extend({
			page_size: z.number().int().min(1).max(1_000).optional(),
			start_after: z.string().min(1).optional(),
		}),
		outputSchema: storageExportOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireStorageUser(ctx)
			const result = await storageRunnerRpc({
				env: ctx.env,
				userId: user.userId,
				storageId: args.storage_id,
			}).exportStorage({
				pageSize: args.page_size,
				startAfter: args.start_after,
			})
			return {
				storage_id: args.storage_id,
				export: result,
			}
		},
	},
)
