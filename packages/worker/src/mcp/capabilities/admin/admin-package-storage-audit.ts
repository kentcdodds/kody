import { z } from 'zod'
import {
	buildPackageStorageAuditReport,
	defaultPackageStorageAuditLimit,
	maxPackageStorageAuditLimit,
} from '#worker/package-storage-audit/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const packageRowSchema = z.object({
	userId: z.string(),
	packageId: z.string(),
	kodyId: z.string(),
	legacyBucketBytes: z.number().nullable(),
	legacyBucketProbeError: z.string().nullable(),
	ambientStorageImportFiles: z.array(z.string()),
	sourceScanError: z.string().nullable(),
})

const orphanBucketSchema = z.object({
	userId: z.string(),
	storageId: z.string(),
	lastSeenAt: z.string(),
})

const outputSchema = z.object({
	ok: z.literal(true),
	packages: z.array(packageRowSchema),
	orphanAppBuckets: z.array(orphanBucketSchema),
	totals: z.object({
		appPackages: z.number().int().nonnegative(),
		nonEmptyLegacyBuckets: z.number().int().nonnegative(),
		packagesWithAmbientImports: z.number().int().nonnegative(),
		orphanAppBuckets: z.number().int().nonnegative(),
		truncated: z.boolean(),
		orphanTruncated: z.boolean(),
	}),
})

export const adminPackageStorageAuditCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_package_storage_audit',
		description:
			'Platform-wide audit of has_app package legacy StorageRunner bucket sizes, ambient storage imports in published sources, and orphaned kind=app buckets. Admin-only and not user-scoped; returns aggregated metadata only, never raw bucket contents or full package source.',
		keywords: [
			'admin',
			'package',
			'storage',
			'audit',
			'legacy bucket',
			'ambient storage',
			'orphan',
		],
		inputSchema: z.object({
			limit: z
				.number()
				.int()
				.min(1)
				.max(maxPackageStorageAuditLimit)
				.optional()
				.describe(
					`Max has_app packages to audit. Defaults to ${String(defaultPackageStorageAuditLimit)} and maxes at ${String(maxPackageStorageAuditLimit)}.`,
				),
		}),
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_package_storage_audit',
				async () =>
					buildPackageStorageAuditReport({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						limit: args.limit ?? defaultPackageStorageAuditLimit,
					}),
			)
		},
	},
)
