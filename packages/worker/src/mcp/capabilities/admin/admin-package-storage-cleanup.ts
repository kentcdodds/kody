import { z } from 'zod'
import {
	cleanupLegacyPackageStorageBuckets,
	defaultPackageStorageAuditLimit,
	InvalidStartAfterCursorError,
	maxPackageStorageAuditLimit,
} from '#worker/package-storage-audit/service.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const outputSchema = z.object({
	ok: z.literal(true),
	buckets: z.array(
		z.object({
			userId: z.string(),
			storageId: z.string(),
			cleared: z.boolean(),
		}),
	),
	nextStartAfter: z.string().nullable(),
	totals: z.object({
		cleared: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
		truncated: z.boolean(),
	}),
})

export const adminPackageStorageCleanupCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_package_storage_cleanup',
		description:
			'Clear legacy raw-package-id app StorageRunner buckets and unregister them from the platform inventory. Admin-only, destructive, and bounded; page with limit + start_after / nextStartAfter until truncated is false.',
		keywords: [
			'admin',
			'package',
			'storage',
			'cleanup',
			'legacy bucket',
			'migration',
		],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			limit: z
				.number()
				.int()
				.min(1)
				.max(maxPackageStorageAuditLimit)
				.optional()
				.describe(
					`Max legacy inventory buckets to clear. Defaults to ${String(defaultPackageStorageAuditLimit)} and maxes at ${String(maxPackageStorageAuditLimit)}.`,
				),
			start_after: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Opaque keyset cursor from a prior nextStartAfter; resumes after that bucket.',
				),
		}),
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_package_storage_cleanup',
				async () => {
					try {
						return await cleanupLegacyPackageStorageBuckets({
							env: ctx.env,
							limit: args.limit ?? defaultPackageStorageAuditLimit,
							startAfter: args.start_after,
						})
					} catch (error) {
						if (error instanceof InvalidStartAfterCursorError) {
							throw new McpCallerError(error.message)
						}
						throw error
					}
				},
			)
		},
	},
)
