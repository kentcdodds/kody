import { z } from 'zod'
import {
	d1StorageReconciliationBatchSize,
	reconcileD1StorageBytes,
} from '#worker/entitlements/d1-storage-reconciliation.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	batch_size: z
		.number()
		.int()
		.min(1)
		.max(d1StorageReconciliationBatchSize)
		.optional()
		.describe(
			`Oldest-first D1 storage-byte reconciliation page size. Defaults to ${d1StorageReconciliationBatchSize}.`,
		),
})

const outputSchema = z.object({
	scanned: z.number().int().nonnegative(),
	updated: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	batchSize: z.number().int().positive(),
	completedAt: z.string().datetime(),
})

export const adminUserMeterStorageReconcileCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_user_meter_storage_reconcile',
		description:
			'Admin-only pre-flip maintenance: run one bounded oldest-first D1 storage-byte reconciliation page while D1 remains authoritative, best-effort shadowing each absolute into UserMeter. Safe to repeat but not idempotent. `failed` counts per-row D1 reconciliation failures only; UserMeter shadow failures are silent and require `admin_user_meter_parity` to detect. Row failures do not fail the invocation. Remove or gate after the storage authority flip.',
		keywords: [
			'admin',
			'user meter',
			'storage bytes',
			'reconcile',
			'reconciliation',
			'parity',
			'cutover',
			'maintenance',
			'd1',
			'shadow',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const batchSize = args.batch_size ?? d1StorageReconciliationBatchSize
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_user_meter_storage_reconcile',
				async () => {
					const now = new Date()
					const result = await reconcileD1StorageBytes({
						db: ctx.env.APP_DB,
						env: ctx.env,
						batchSize,
						now,
					})
					return {
						...result,
						batchSize,
						completedAt: new Date().toISOString(),
					}
				},
				{
					successReason: (result) =>
						`scanned=${result.scanned};updated=${result.updated};failed=${result.failed};batch_size=${result.batchSize}`,
				},
			)
		},
	},
)
