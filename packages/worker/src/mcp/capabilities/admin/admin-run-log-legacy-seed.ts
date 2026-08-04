import { z } from 'zod'
import {
	adminRunLogLegacySeedActivationMaxMilestones,
	adminRunLogLegacySeedActivationMaxPackages,
	adminRunLogLegacySeedDefaultUserLimit,
	adminRunLogLegacySeedDefaultWorkflowImportPageSize,
	adminRunLogLegacySeedMaxUserLimit,
	runAdminRunLogLegacySeed,
} from '#worker/admin/run-log-legacy-seed.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const userLimitSchema = z
	.number()
	.int()
	.min(1)
	.max(adminRunLogLegacySeedMaxUserLimit)
	.optional()
	.describe(
		`Optional non-deleting user page size (1–${adminRunLogLegacySeedMaxUserLimit}). Defaults to ${adminRunLogLegacySeedDefaultUserLimit}.`,
	)

const bucketCountsSchema = z.object({
	matched: z.number().int().nonnegative(),
	missing: z.number().int().nonnegative(),
	underCount: z.number().int().nonnegative(),
})

const failureStageSchema = z
	.enum(['workflow_inventory', 'job_inventory', 'activation_inventory'])
	.nullable()
	.describe(
		'Null on success; which inventory surface threw on failure (failed users only).',
	)

const failurePhaseSchema = z
	.enum(['d1', 'seed', 'verify'])
	.nullable()
	.describe(
		'Null on success; which step within the surface threw on failure (failed users only).',
	)

const userResultSchema = z.object({
	stableUserId: stableUserIdSchema,
	failed: z
		.boolean()
		.describe(
			'True when this user threw (D1/RPC/cap). Failed users are not production evidence and must be rerun; bucket counts are zeroed and parity is false.',
		),
	failureStage: failureStageSchema,
	failurePhase: failurePhaseSchema,
	parity: z
		.boolean()
		.describe(
			'True when failed is false, activation is initialized, and every D1 workflow/job/activation check matched. DO-only rows are allowed.',
		),
	activationInitialized: z.boolean(),
	workflows: bucketCountsSchema,
	jobs: bucketCountsSchema,
	activationPackages: bucketCountsSchema,
	activationMilestones: bucketCountsSchema,
})

const pageFields = {
	generatedAt: z.string(),
	users: z.array(userResultSchema),
	usersAttempted: z.number().int().nonnegative(),
	usersAtParity: z.number().int().nonnegative(),
	nextStartAfter: stableUserIdSchema
		.nullable()
		.describe(
			'Pass as start_after_user_id on the next call when truncated is true.',
		),
	truncated: z
		.boolean()
		.describe(
			'True when a limit+1 probe found more non-deleting users beyond this page.',
		),
}

const inputSchema = z.discriminatedUnion('action', [
	z
		.object({
			action: z.literal('status'),
			limit: userLimitSchema,
			start_after_user_id: stableUserIdSchema
				.optional()
				.describe(
					'Stable-user-id keyset cursor from a prior nextStartAfter. Ordered by stable_user_id ASC across all non-deleting users.',
				),
		})
		.strict(),
	z
		.object({
			action: z.literal('seed'),
			limit: userLimitSchema,
			start_after_user_id: stableUserIdSchema
				.optional()
				.describe(
					'Stable-user-id keyset cursor from a prior nextStartAfter. Ordered by stable_user_id ASC across all non-deleting users.',
				),
		})
		.strict(),
])

const outputSchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('status'),
		...pageFields,
	}),
	z.object({
		action: z.literal('seed'),
		...pageFields,
	}),
])

export const adminRunLogLegacySeedCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'admin_run_log_legacy_seed',
		description: `Admin-only non-destructive RunLog legacy expand sweep. Keyset-pages all non-deleting users (not only legacy-inventory candidates) with exact limit+1 truncation (default ${adminRunLogLegacySeedDefaultUserLimit}, max ${adminRunLogLegacySeedMaxUserLimit} users/call). \`status\` is read-only content-free parity; \`seed\` idempotently imports each D1 workflow/job page immediately (${adminRunLogLegacySeedDefaultWorkflowImportPageSize} workflow rows per D1 page/import RPC; workflows checked with minimumUpdatedAt; every job including zero legacy state), then imports activation as one bounded one-shot snapshot (packages capped at max plan saved-packages ${adminRunLogLegacySeedActivationMaxPackages}; milestones filtered to ${adminRunLogLegacySeedActivationMaxMilestones} known names with unknown/retired rows ignored; empty activation still marks initialized) and returns the same parity shape. Missing D1 relations/columns and other per-user D1/RPC failures set failed=true (parity false; failureStage/failurePhase name the surface and step; not production evidence — rerun) and continue other users. Output is stable user ids, counts, booleans (including failed, failureStage, failurePhase), cursors, and generatedAt only — never emails, names, workflow names, package ids, job ids, or user-authored content. Audited.`,
		keywords: [
			'admin',
			'run log',
			'legacy',
			'seed',
			'parity',
			'cutover',
			'workflow runs',
			'job observability',
			'activation',
			'maintenance',
			'sweep',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'admin_run_log_legacy_seed',
				async () => {
					switch (args.action) {
						case 'status':
						case 'seed': {
							const result = await runAdminRunLogLegacySeed({
								env: ctx.env,
								action: args.action,
								limit: args.limit,
								startAfterUserId: args.start_after_user_id,
							})
							return result
						}
						default: {
							const exhaustive: never = args
							throw new Error(
								`Unhandled admin_run_log_legacy_seed action: ${JSON.stringify(exhaustive)}`,
							)
						}
					}
				},
				{
					successReason: (result) => {
						switch (result.action) {
							case 'status':
								return `action=status;attempted=${result.usersAttempted};at_parity=${result.usersAtParity};truncated=${result.truncated ? 1 : 0}`
							case 'seed':
								return `action=seed;attempted=${result.usersAttempted};at_parity=${result.usersAtParity};truncated=${result.truncated ? 1 : 0}`
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
