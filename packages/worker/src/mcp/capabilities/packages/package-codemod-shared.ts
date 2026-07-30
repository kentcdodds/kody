import { z } from 'zod'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	runPackageCodemodStep,
	type PackageCodemodRunMode,
} from '#worker/package-codemods/engine.ts'

export const packageCodemodItemStatusSchema = z.enum([
	'detected',
	'clean',
	'dry_run_ok',
	'dry_run_new_failures',
	'needs_manual',
	'skipped_drift',
	'skipped_unpublished',
	'applied',
	'reverted',
	'failed',
])

export const packageCodemodRunModeSchema = z.enum([
	'scan',
	'dry-run',
	'apply',
	'revert',
])

export const packageCodemodFindingSchema = z.object({
	path: z.string().nullable(),
	message: z.string(),
})

export const packageCodemodRunItemSchema = z.object({
	itemId: z.string(),
	userId: z.string(),
	packageId: z.string(),
	kodyId: z.string(),
	status: packageCodemodItemStatusSchema,
	changedPaths: z.array(z.string()),
	findings: z.array(packageCodemodFindingSchema),
	beforeCommit: z.string().nullable(),
	afterCommit: z.string().nullable(),
	checkSummary: z
		.object({
			ok: z.boolean(),
			newFailures: z.array(z.string()),
		})
		.nullable(),
	error: z.string().nullable(),
})

export const packageCodemodStepResultSchema = z.object({
	runId: z.string().describe('Codemod run id; pass back when paging.'),
	codemodId: z.string(),
	mode: packageCodemodRunModeSchema,
	items: z.array(packageCodemodRunItemSchema),
	nextCursor: z
		.string()
		.nullable()
		.describe(
			'Opaque cursor for the next page, or null when this is the last page.',
		),
	summary: z.partialRecord(
		packageCodemodItemStatusSchema,
		z.number().int().nonnegative(),
	),
})

export const packageCodemodStepInputSchema = z.object({
	codemodId: z
		.string()
		.min(1)
		.describe('Registered package codemod id from package_codemod_list.'),
	packageIds: z
		.array(z.string().min(1))
		.optional()
		.describe('Optional saved package ids to limit this step.'),
	runId: z
		.string()
		.min(1)
		.optional()
		.describe('Existing run id to continue; required with cursor when paging.'),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('Opaque pagination cursor from a previous nextCursor value.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe(
			'Max packages to process in this step. Scan: default 20, max 50. Dry-run, apply, and revert are check-heavy: default 5, max 10 (higher values are clamped).',
		),
})

export const packageCodemodRevertInputSchema = z.object({
	revertOfRunId: z
		.string()
		.min(1)
		.describe('Prior apply run id whose applied items should be reverted.'),
	runId: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Existing revert run id to continue; required with cursor when paging.',
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('Opaque pagination cursor from a previous nextCursor value.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(10)
		.optional()
		.describe(
			'Max items to revert in this step (default 5, max 10 — reverts republish packages and are check-heavy).',
		),
})

export const packageCodemodFiltersSchema = z
	.object({
		userIds: z
			.array(z.string().min(1))
			.optional()
			.describe('Optional user ids to canary or limit a fleet run.'),
		packageIds: z
			.array(z.string().min(1))
			.optional()
			.describe('Optional saved package ids to limit a fleet run.'),
	})
	.describe('Optional fleet filters for canary or partial runs.')

export const adminPackageCodemodStepInputSchema =
	packageCodemodStepInputSchema.extend({
		filters: packageCodemodFiltersSchema.optional(),
	})

export const adminPackageCodemodRevertInputSchema =
	packageCodemodRevertInputSchema.extend({
		filters: packageCodemodFiltersSchema.optional(),
	})

export const packageCodemodListOutputSchema = z.object({
	codemods: z.array(
		z.object({
			id: z.string(),
			description: z.string(),
		}),
	),
})

const pagingDescription =
	'Paged: call again with runId and nextCursor until nextCursor is null.'

export const packageCodemodPagingHint = pagingDescription

export async function runCallerPackageCodemodStep(
	ctx: CapabilityContext,
	input: {
		codemodId: string
		mode: Exclude<PackageCodemodRunMode, 'revert'>
		packageIds?: Array<string>
		runId?: string
		cursor?: string
		limit?: number
	},
) {
	const user = requireMcpUser(ctx.callerContext)
	return await runPackageCodemodStep({
		env: ctx.env,
		baseUrl: ctx.callerContext.baseUrl,
		initiatedByUserId: user.userId,
		codemodId: input.codemodId,
		mode: input.mode,
		scope: { kind: 'user', userId: user.userId },
		filters: input.packageIds ? { packageIds: input.packageIds } : undefined,
		runId: input.runId,
		cursor: input.cursor,
		limit: input.limit,
	})
}

export async function runFleetPackageCodemodStep(
	ctx: CapabilityContext,
	input: {
		codemodId: string
		mode: PackageCodemodRunMode
		packageIds?: Array<string>
		filters?: {
			userIds?: Array<string>
			packageIds?: Array<string>
		}
		runId?: string
		cursor?: string
		limit?: number
		revertOfRunId?: string
	},
) {
	const user = requireMcpUser(ctx.callerContext)
	const packageIds = input.filters?.packageIds ?? input.packageIds
	const filters =
		input.filters?.userIds != null || packageIds != null
			? {
					...(input.filters?.userIds != null
						? { userIds: input.filters.userIds }
						: {}),
					...(packageIds != null ? { packageIds } : {}),
				}
			: undefined
	return await runPackageCodemodStep({
		env: ctx.env,
		baseUrl: ctx.callerContext.baseUrl,
		initiatedByUserId: user.userId,
		codemodId: input.codemodId,
		mode: input.mode,
		scope: { kind: 'fleet' },
		filters,
		runId: input.runId,
		cursor: input.cursor,
		limit: input.limit,
		revertOfRunId: input.revertOfRunId,
	})
}
