import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	credentialInventoryFailureListMax,
	credentialInventoryScanLimitDefault,
	credentialInventoryScanLimitMax,
	getCredentialInventoryReport,
	runCredentialInventoryScanStep,
} from '#worker/credentials/credential-inventory.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const placeholderCountsSchema = z.object({
	secret: count,
	'secret-basic': count,
	'integration-token': count,
	vault: count,
	computed: count,
})

export const credentialInventoryReportSchema = z.object({
	packages: z.object({
		scanned: count,
		unpublished: count,
		failed: count,
		withPlaceholders: count,
		withSlots: count,
	}),
	placeholders: placeholderCountsSchema.describe(
		'Every placeholder occurrence by kind, including ones that match a declared slot.',
	),
	unparsedModules: count,
	references: z.object({
		total: count,
		attributed: count,
		unattributed: count,
		byPlacement: z.object({
			header: count,
			query: count,
			'header-custom': count,
			basic: count,
			path: count,
			body: count,
			other: count,
		}),
	}),
	slots: z.object({
		total: count,
		attributed: count,
		byKind: z.object({ secret: count, oauth: count, mcp: count }),
	}),
	credentialsReferenced: count,
	failures: z
		.array(z.object({ packageId: z.string(), error: z.string() }))
		.describe(
			`Packages the run could not scan, with the load error (first ${credentialInventoryFailureListMax} by package id). A backfill apply refuses while any remain.`,
		),
})

const inputSchema = z.object({
	runId: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Inventory run to continue. Omit to start a new run. A complete run returns its report again.',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(credentialInventoryScanLimitMax)
		.optional()
		.describe(
			`Saved packages to scan in this step (default ${credentialInventoryScanLimitDefault}, max ${credentialInventoryScanLimitMax}).`,
		),
})

const outputSchema = z.object({
	runId: z.string(),
	complete: z.boolean(),
	page: z.object({ scanned: count, unpublished: count, failed: count }),
	report: credentialInventoryReportSchema
		.nullable()
		.describe('Aggregate counts for the whole run, once it is complete.'),
})

export const adminCredentialInventoryScanCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminCredentialInventoryScan',
		description:
			'Fleet inventory of credential placeholders in published package source (ADR 0068). Changes no package or credential: it records, per package, which credential ids each placeholder can fill, where the placeholder sits on a request, and the declared slot providers. Never records credential names or values. Paged: call again with the returned runId until complete is true; the final call returns the report.',
		keywords: [
			'admin',
			'credential',
			'inventory',
			'placeholder',
			'scan',
			'fleet',
			'secret',
			'integration',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminCredentialInventoryScan',
				async () => {
					const step = await runCredentialInventoryScanStep({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						initiatedByUserId: user.userId,
						runId: args.runId,
						limit: args.limit,
					})
					const report = step.complete
						? (await getCredentialInventoryReport(ctx.env.APP_DB, step.runId))
								.report
						: null
					return { ...step, report }
				},
				{
					successReason: (result) =>
						`run=${result.runId};complete=${result.complete};scanned=${result.page.scanned};failed=${result.page.failed}`,
				},
			)
		},
	},
)
