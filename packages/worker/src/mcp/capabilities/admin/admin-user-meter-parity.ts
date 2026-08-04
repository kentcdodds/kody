import { z } from 'zod'
import { loadAdminUserMeterParityReport } from '#worker/admin/user-meter-parity.ts'
import { dailyEntitlementResources } from '#worker/entitlements/user-meter-do.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const dailyResourceSchema = z.enum(dailyEntitlementResources)

const dailyResourceReadSchema = z.object({
	resource: dailyResourceSchema,
	meterCount: z.number().int().nonnegative().nullable(),
	needsBootstrap: z.boolean(),
})

const storageParitySchema = z.object({
	d1Bytes: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Physical recompute from D1 payload tables (the reconcile-lane source), not a stored mirror.',
		),
	meterBytes: z.number().int().nonnegative().nullable(),
	needsBootstrap: z.boolean(),
	delta: z.number().int().nullable(),
	parity: z.boolean(),
})

const packageServiceMismatchCategoriesSchema = z.object({
	d1Only: z.number().int().nonnegative(),
	meterOnly: z.number().int().nonnegative(),
	statusMismatch: z.number().int().nonnegative(),
	startedAtMismatch: z.number().int().nonnegative(),
	sourceUpdatedAtMismatch: z.number().int().nonnegative(),
})

const packageServicesParitySchema = z.object({
	d1Count: z.number().int().nonnegative(),
	meterCount: z.number().int().nonnegative(),
	truncated: z.boolean(),
	mismatchCategories: packageServiceMismatchCategoriesSchema,
	running: z.object({
		d1FreshRunningCount: z.number().int().nonnegative(),
		meterRunningCount: z.number().int().nonnegative(),
		parity: z.boolean(),
	}),
	parity: z.boolean(),
})

const deletionParitySchema = z.object({
	d1DeletingAt: z.string().nullable(),
	meterDeletingAt: z.string().nullable(),
	deletingAtParity: z
		.boolean()
		.describe(
			'True when D1 users.deleting_at matches the UserMeter tombstone.',
		),
	activeLeaseCount: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Count of active DO write leases in UserMeter. D1 account_write_leases is quiescent and not queried.',
		),
})

const reportSchema = z.object({
	generatedAt: z.string(),
	stableUserId: stableUserIdSchema,
	daily: z
		.object({
			day: z.string(),
			resources: z.array(dailyResourceReadSchema),
		})
		.describe(
			'UserMeter-only daily counter reads. The D1 entitlement_daily_counters mirror was dropped by migration 0126; no D1 comparison exists.',
		),
	storage: storageParitySchema,
	packageServices: packageServicesParitySchema,
	deletion: deletionParitySchema,
})

const inputSchema = z.object({
	stable_user_id: stableUserIdSchema,
})

const outputSchema = z.object({
	report: reportSchema.nullable(),
})

export const adminUserMeterParityCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_user_meter_parity',
		description:
			'Read-only production verification report for one user: UserMeter daily counter reads (meter-only; the D1 mirror is dropped) plus D1↔UserMeter parity for storage bytes, package-service liveness, and deletion state. Deletion parity reports `deletingAtParity` (D1 vs meter tombstone) and `activeLeaseCount` (active DO write leases in UserMeter; D1 account_write_leases is quiescent and not queried). Never bootstraps or writes parity state; returns counts and parity only (no lease tokens/holders or email content). Admin-only.',
		keywords: [
			'admin',
			'user meter',
			'parity',
			'daily counters',
			'storage bytes',
			'package services',
			'write leases',
			'deletion',
			'bootstrap',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_user_meter_parity',
				async () => ({
					report: await loadAdminUserMeterParityReport({
						db: ctx.env.APP_DB,
						env: ctx.env,
						stableUserId: args.stable_user_id,
					}),
				}),
				{
					successReason: () => `target_stable_user_id=${args.stable_user_id}`,
				},
			)
		},
	},
)
