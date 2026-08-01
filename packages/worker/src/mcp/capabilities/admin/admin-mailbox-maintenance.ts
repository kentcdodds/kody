import { z } from 'zod'
import {
	adminMailboxMaintenanceMaxBatchSize,
	loadAdminMailboxMaintenanceStatus,
	runAdminMailboxMaintenanceReconcile,
	runAdminMailboxMaintenanceRetention,
} from '#worker/admin/mailbox-maintenance.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const batchSizeSchema = z
	.number()
	.int()
	.min(1)
	.max(adminMailboxMaintenanceMaxBatchSize)
	.optional()
	.describe(
		`Optional bounded owner batch size (1–${adminMailboxMaintenanceMaxBatchSize}). Defaults to the scheduled parity lane batch size.`,
	)

const statusSchema = z.object({
	generatedAt: z.string(),
	trackedOwners: z.number().int().nonnegative(),
	matching: z.number().int().nonnegative(),
	mismatch: z.number().int().nonnegative(),
	error: z.number().int().nonnegative(),
	incomplete: z.number().int().nonnegative(),
	eligible: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Tracked owners meeting parity soak timing (matching_since age + fresh checked_at, zero mismatch/error). Does not require the read-cutover feature flag.',
		),
	oldestMatchingSince: z.string().nullable(),
	newestMatchingSince: z.string().nullable(),
	oldestCheckedAt: z.string().nullable(),
	newestCheckedAt: z.string().nullable(),
	earliestCutoverAt: z
		.string()
		.nullable()
		.describe(
			'Earliest matching_since + soak duration among matching owners, or null.',
		),
})

const reconcileMetricsSchema = z.object({
	scanned: z.number().int().nonnegative(),
	backfilled: z.number().int().nonnegative(),
	compared: z.number().int().nonnegative(),
	matched: z.number().int().nonnegative(),
	mismatched: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
})

const retentionMetricsSchema = z.object({
	ownersAttempted: z.number().int().nonnegative(),
	ownersSucceeded: z.number().int().nonnegative(),
	ownersFailed: z.number().int().nonnegative(),
	messagesDeleted: z.number().int().nonnegative(),
	threadsDeleted: z.number().int().nonnegative(),
	attachmentsDeleted: z.number().int().nonnegative(),
	deliveryEventsDeleted: z.number().int().nonnegative(),
	blobDeleteFailureOwners: z.number().int().nonnegative(),
	expiredRemainingOwners: z.number().int().nonnegative(),
})

const inputSchema = z.discriminatedUnion('action', [
	z
		.object({
			action: z.literal('status'),
		})
		.strict(),
	z
		.object({
			action: z.literal('reconcile'),
			batch_size: batchSizeSchema,
		})
		.strict(),
	z
		.object({
			action: z.literal('retention'),
			batch_size: batchSizeSchema,
		})
		.strict(),
])

const outputSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('status'),
		status: statusSchema,
	}),
	z.object({
		action: z.literal('reconcile'),
		metrics: reconcileMetricsSchema,
		status: statusSchema,
	}),
	z.object({
		action: z.literal('retention'),
		metrics: retentionMetricsSchema,
		status: statusSchema,
	}),
])

export const adminMailboxMaintenanceCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_mailbox_maintenance',
		description:
			'Admin-only Mailbox parity/retention maintenance: aggregate status (no email content), bounded reconcileMailboxParity, or bounded owner-discovered natural retention passes via Mailbox.runRetentionNow. Never accepts arbitrary cutoffs or seed data. Audited.',
		keywords: [
			'admin',
			'mailbox',
			'maintenance',
			'parity',
			'reconcile',
			'retention',
			'cutover',
			'soak',
		],
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_mailbox_maintenance',
				async () => {
					switch (args.action) {
						case 'status': {
							const status = await loadAdminMailboxMaintenanceStatus({
								db: ctx.env.APP_DB,
							})
							return { action: 'status' as const, status }
						}
						case 'reconcile': {
							const result = await runAdminMailboxMaintenanceReconcile({
								env: ctx.env,
								batchSize: args.batch_size,
							})
							return {
								action: 'reconcile' as const,
								metrics: result.metrics,
								status: result.status,
							}
						}
						case 'retention': {
							const result = await runAdminMailboxMaintenanceRetention({
								env: ctx.env,
								batchSize: args.batch_size,
							})
							return {
								action: 'retention' as const,
								metrics: result.metrics,
								status: result.status,
							}
						}
						default: {
							const exhaustive: never = args
							throw new Error(
								`Unhandled admin_mailbox_maintenance action: ${JSON.stringify(exhaustive)}`,
							)
						}
					}
				},
				{
					successReason: (result) => {
						switch (result.action) {
							case 'status':
								return `action=status;tracked=${result.status.trackedOwners}`
							case 'reconcile':
								return `action=reconcile;scanned=${result.metrics.scanned};matched=${result.metrics.matched}`
							case 'retention':
								return `action=retention;attempted=${result.metrics.ownersAttempted};succeeded=${result.metrics.ownersSucceeded}`
							default: {
								const exhaustive: never = result
								return `action=unknown;${JSON.stringify(exhaustive)}`
							}
						}
					},
				},
			)
		},
	},
)
