import { z } from 'zod'
import { planNames } from '#worker/entitlements/plans.ts'
import { loadAdminUserByIdOrEmail } from '#worker/admin/users-data.ts'
import { loadAdminUserUsageData } from '#worker/admin/user-usage-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const usageMetricSchema = z.enum([
	'execute',
	'package_export',
	'package_static_call',
	'job_run',
	'workflow_run',
	'service_runtime',
	'outbound_fetch',
	'email_send',
	'email_received',
])

const entitlementResourceSchema = z.enum([
	'saved_packages',
	'scheduled_jobs',
	'package_services',
	'persistent_package_services',
	'repo_sessions',
	'email_sends_per_day',
	'email_receives_per_day',
	'stored_email_messages',
	'secrets',
	'concurrent_workflows',
	'storage_bytes',
	'execute_calls_per_day',
	'outbound_fetches_per_day',
])

const planSchema = z.enum(planNames)

const usageRollupSchema = z.object({
	metric: usageMetricSchema,
	eventCount: z.number().int().nonnegative(),
	errorCount: z.number().int().nonnegative(),
	totalDurationMs: z.number().int().nonnegative(),
	totalCpuMs: z.number().int().nonnegative(),
	totalBytes: z.number().int().nonnegative(),
})

const entitlementConsumptionSchema = z.object({
	resource: entitlementResourceSchema,
	label: z.string(),
	/** Finite usage count; every plan resolves a numeric current. */
	current: z.number().int().nonnegative(),
	/** Finite plan ceiling; every plan resolves a numeric limit. */
	limit: z.number().int().nonnegative(),
	/** Null when limit is the zero gate (for example persistent services). */
	percentOfLimit: z.number().nonnegative().nullable(),
	overEightyPercent: z.boolean(),
})

const inputSchema = z
	.object({
		id: z
			.number()
			.int()
			.positive()
			.optional()
			.describe('Numeric users.id to look up.'),
		email: z.string().email().optional().describe('Email address to look up.'),
	})
	.refine((value) => value.id !== undefined || value.email !== undefined, {
		message: 'Provide either id or email.',
	})

const outputSchema = z.object({
	usage: z
		.object({
			userId: z.number().int().positive(),
			username: z.string(),
			plan: planSchema,
			currentMonth: z.string(),
			today: z.string(),
			currentMonthUsage: z.array(usageRollupSchema),
			monthUsage: z.array(
				z.object({
					month: z.string(),
					usage: z.array(usageRollupSchema),
				}),
			),
			entitlementConsumption: z.array(entitlementConsumptionSchema),
			warnings: z.array(entitlementConsumptionSchema),
		})
		.nullable(),
})

export const adminUserUsageCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_user_usage',
		description:
			'Read usage rollups, entitlement counters, and plan-limit consumption for one user account by id or email. Admin-only; never returns user content.',
		keywords: ['admin', 'usage', 'quotas', 'entitlements', 'plans', 'metering'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_user_usage',
				async () => {
					const user = await loadAdminUserByIdOrEmail(ctx.env.APP_DB, args)
					if (!user) return { usage: null }
					const data = await loadAdminUserUsageData(ctx.env, user.id)
					if (!data) return { usage: null }
					const { ok: _ok, ...usage } = data
					return { usage }
				},
			)
		},
	},
)
