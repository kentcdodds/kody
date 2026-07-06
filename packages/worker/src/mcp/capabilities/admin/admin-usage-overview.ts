import { z } from 'zod'
import { loadAdminUsageData } from '#app/admin-usage-data.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const usageMetricSchema = z.enum([
	'execute',
	'package_export',
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
])

const planSchema = z.enum(['partner', 'personal', 'pro']).nullable()

const usageRollupSchema = z.object({
	metric: usageMetricSchema,
	eventCount: z.number().int().nonnegative(),
	errorCount: z.number().int().nonnegative(),
	totalDurationMs: z.number().int().nonnegative(),
	totalCpuMs: z.number().int().nonnegative(),
	totalBytes: z.number().int().nonnegative(),
})

const dailyCounterSchema = z.object({
	resource: entitlementResourceSchema,
	label: z.string(),
	count: z.number().int().nonnegative(),
})

const resourceCountSchema = z.object({
	resource: entitlementResourceSchema,
	label: z.string(),
	current: z.number().int().nonnegative(),
})

const entitlementConsumptionSchema = z.object({
	resource: entitlementResourceSchema,
	label: z.string(),
	current: z.number().int().nonnegative().nullable(),
	limit: z.number().int().nonnegative().nullable(),
	percentOfLimit: z.number().nonnegative().nullable(),
	overEightyPercent: z.boolean(),
})

const userSummarySchema = z.object({
	id: z.number().int().positive(),
	username: z.string(),
	email: z.string(),
	plan: planSchema,
	currentMonthUsage: z.array(usageRollupSchema),
	todayCounters: z.array(dailyCounterSchema),
	resourceCounts: z.array(resourceCountSchema),
})

const selectedUserSchema = userSummarySchema.extend({
	monthUsage: z.array(
		z.object({
			month: z.string(),
			usage: z.array(usageRollupSchema),
		}),
	),
	entitlementConsumption: z.array(entitlementConsumptionSchema),
	warnings: z.array(entitlementConsumptionSchema),
})

const inputSchema = z.object({
	page: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('One-indexed page of users to return. Defaults to 1.'),
	pageSize: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Users per page. Defaults to 20 and maxes at 100.'),
	userId: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('Numeric account id to include in the drill-down section.'),
})

const outputSchema = z.object({
	users: z.array(userSummarySchema),
	selectedUser: selectedUserSchema.nullable(),
	page: z.number().int().positive(),
	pageSize: z.number().int().positive(),
	total: z.number().int().nonnegative(),
	currentMonth: z.string(),
	today: z.string(),
})

export const adminUsageOverviewCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_usage_overview',
		description:
			'Read usage rollups, entitlement counters, and resource counts for account metadata. Admin-only; never returns user content.',
		keywords: ['admin', 'usage', 'quotas', 'entitlements', 'plans', 'metering'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_usage_overview',
				async () => {
					const url = new URL('https://kody.local/admin/usage.json')
					if (args.page) url.searchParams.set('page', String(args.page))
					if (args.pageSize) {
						url.searchParams.set('pageSize', String(args.pageSize))
					}
					if (args.userId) url.searchParams.set('userId', String(args.userId))
					const { ok: _ok, ...data } = await loadAdminUsageData(
						ctx.env,
						url.toString(),
					)
					return data
				},
			)
		},
	},
)
