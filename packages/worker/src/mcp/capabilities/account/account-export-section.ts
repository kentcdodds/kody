import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	readAccountExportSection,
	resolveAccountExportDbUserId,
} from '#app/account-export.ts'
import {
	accountExportSectionOutputSchema,
	accountExportSectionSchema,
} from './account-export-shared.ts'

export const accountExportSectionCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'account_export_section',
		description:
			'Read a paged section of the signed-in user account export. Use account_export_manifest first for section counts and warnings. Secret values are never exported.',
		keywords: ['account', 'export', 'chunk', 'backup', 'migration'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			section: accountExportSectionSchema,
			table: z
				.string()
				.min(1)
				.optional()
				.describe('Required when section is d1_table.'),
			storage_id: z
				.string()
				.min(1)
				.optional()
				.describe('Required when section is storage_runner.'),
			instance_id: z
				.string()
				.min(1)
				.optional()
				.describe('Required when section is remote_connector_session.'),
			package_id: z
				.string()
				.min(1)
				.optional()
				.describe('Required when section is package_service.'),
			service_name: z
				.string()
				.min(1)
				.optional()
				.describe('Required when section is package_service.'),
			kind: z
				.enum([
					'storage_runner',
					'remote_connector_session',
					'package_service',
					'job_manager',
				])
				.optional()
				.describe('Required when section is durable_object_summaries.'),
			page_size: z.number().int().min(1).max(500).optional(),
			start_after: z
				.string()
				.min(1)
				.optional()
				.describe('Opaque cursor from a previous account_export_section page.'),
		}),
		outputSchema: accountExportSectionOutputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const dbUserId = await resolveAccountExportDbUserId({
				env: ctx.env,
				mcpUserId: user.userId,
				email: user.email,
			})
			const result = await readAccountExportSection({
				env: ctx.env,
				dbUserId,
				mcpUserId: user.userId,
				section: args.section,
				table: args.table,
				storageId: args.storage_id,
				instanceId: args.instance_id,
				packageId: args.package_id,
				serviceName: args.service_name,
				kind: args.kind,
				pageSize: args.page_size,
				startAfter: args.start_after,
			})
			return {
				section: result.section,
				items: result.items,
				truncated: result.truncated,
				next_start_after: result.nextStartAfter,
				page_size: result.pageSize,
				warnings: result.warnings,
			}
		},
	},
)
