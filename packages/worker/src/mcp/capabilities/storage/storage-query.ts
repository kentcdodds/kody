import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { storageIdSchema } from './shared.ts'

const outputSchema = z.object({
	ok: z.literal(true),
	storage_id: z.string(),
	query: z.string(),
	columns: z.array(z.string()),
	rows: z.array(
		z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
	),
	row_count: z.number(),
	rows_read: z.number(),
	rows_written: z.number(),
	writable: z.boolean(),
})

export const storageQueryCapability = defineDomainCapability(
	capabilityDomainNames.storage,
	{
		name: 'storage_query',
		description:
			'Run SQL against one durable storage bucket. Defaults to read-only and only allows SELECT, EXPLAIN, and schema PRAGMA queries unless writable is explicitly true.',
		keywords: ['storage', 'sql', 'sqlite', 'query', 'inspect', 'database'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: storageIdSchema.extend({
			query: z.string().min(1),
			params: z
				.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
				.optional()
				.describe('Optional positional SQL bindings.'),
			writable: z
				.boolean()
				.optional()
				.describe(
					'Optional write access toggle. Defaults to false for inspection workflows.',
				),
		}),
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await storageRunnerRpc({
				env: ctx.env,
				userId: user.userId,
				storageId: args.storage_id,
			}).sqlQuery({
				query: args.query,
				params: args.params,
				writable: args.writable ?? false,
			})
			return {
				ok: true as const,
				storage_id: args.storage_id,
				query: args.query,
				columns: result.columns,
				rows: result.rows,
				row_count: result.rowCount,
				rows_read: result.rowsRead,
				rows_written: result.rowsWritten,
				writable: args.writable ?? false,
			}
		},
	},
)
