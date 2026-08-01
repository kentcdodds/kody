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

const dailyResourceParitySchema = z.object({
	resource: dailyResourceSchema,
	d1Count: z.number().int().nonnegative().nullable(),
	meterCount: z.number().int().nonnegative().nullable(),
	needsBootstrap: z.boolean(),
	delta: z.number().int().nullable(),
	parity: z.boolean(),
})

const storageParitySchema = z.object({
	d1Bytes: z.number().int().nonnegative(),
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

const deletionLeaseTokenMismatchesSchema = z.object({
	d1Only: z.number().int().nonnegative(),
	doOnly: z.number().int().nonnegative(),
	legacyWithoutD1: z.number().int().nonnegative(),
})

const deletionParitySchema = z.object({
	d1DeletingAt: z.string().nullable(),
	meterDeletingAt: z.string().nullable(),
	deletingAtParity: z.boolean(),
	d1ActiveLeaseCount: z.number().int().nonnegative(),
	doAuthorityLeaseCount: z.number().int().nonnegative(),
	doLegacyLeaseCount: z.number().int().nonnegative(),
	tokenSetMismatches: deletionLeaseTokenMismatchesSchema,
	truncated: z.boolean(),
	mirrorLeaseParity: z
		.boolean()
		.describe(
			'Temporary same-token D1 mirror readiness: doOnly and legacyWithoutD1 are zero, inventory is not truncated, and d1ActiveLeaseCount covers doAuthorityLeaseCount. d1Only is reported separately and does not fail this gate.',
		),
})

const reportSchema = z.object({
	generatedAt: z.string(),
	stableUserId: stableUserIdSchema,
	daily: z.object({
		day: z.string(),
		mirrorRetired: z
			.boolean()
			.describe(
				'True when D1 entitlement_daily_counters is absent. Daily gate then reports meter counts only; d1Count/delta are null and parity stays true (no D1 comparison).',
			),
		resources: z.array(dailyResourceParitySchema),
		mismatchCount: z.number().int().nonnegative(),
	}),
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
			'Read-only production verification report for one user: UserMeter daily counters plus D1↔UserMeter parity for storage bytes, package-service liveness, and deletion write leases. While `entitlement_daily_counters` exists, daily rows compare D1 mirror counts (`mirrorRetired: false`); after the drop migration, daily rows report meter counts only (`mirrorRetired: true`). Never bootstraps or writes parity state (DO constructor schema maintenance and stale daily pruning may still run); returns counts and parity only (no lease tokens/holders or email content). Admin-only.',
		keywords: [
			'admin',
			'user meter',
			'parity',
			'cutover',
			'daily counters',
			'storage bytes',
			'package services',
			'write leases',
			'deletion',
			'mirror',
			'bootstrap',
			'retired',
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
