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
	temporaryMirrorRetired: z
		.literal(true)
		.describe(
			'Always true: the same-token D1 mirror is retired (2026-08-01). DO-authority leases do not write a D1 row on acquire; doOnly is expected and does not indicate a problem.',
		),
	mirrorLeaseParity: z
		.boolean()
		.describe(
			'Lease readiness with the temporary D1 mirror retired: legacyWithoutD1 is zero and inventory is not truncated. doOnly is expected and does not fail this gate. d1Only reflects legacy email leases and historical stale rows.',
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
			'Read-only production verification report for one user: UserMeter daily counters plus D1↔UserMeter parity for storage bytes, package-service liveness, and deletion write leases. Daily rows report meter counts only when `mirrorRetired: true`. Deletion parity reports `temporaryMirrorRetired: true`; `doOnly` is expected and does not fail `mirrorLeaseParity` — only `legacyWithoutD1` (legacy-authority meter leases without a D1 row) and truncated inventory do. DO-authority leases do not write D1 rows. `d1Only` reflects legacy email leases and historical stale pre-retirement rows. Never bootstraps or writes parity state; returns counts and parity only (no lease tokens/holders or email content). Admin-only.',
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
