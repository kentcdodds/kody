import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { runPackageCodemodStep } from '#worker/package-codemods/engine.ts'
import { getPackageCodemodRunById } from '#worker/package-codemods/ledger.ts'
import {
	packageCodemodPagingHint,
	packageCodemodRevertInputSchema,
	packageCodemodStepResultSchema,
} from './package-codemod-shared.ts'

export const packageCodemodRevertCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_codemod_revert',
		description: `Revert a prior package_codemod_apply run for the signed-in user’s packages by republishing stored pre-codemod snapshots. ${packageCodemodPagingHint}`,
		keywords: [
			'package',
			'codemod',
			'revert',
			'undo',
			'migration',
			'package codemod',
		],
		tags: ['codemod'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: packageCodemodRevertInputSchema,
		outputSchema: packageCodemodStepResultSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const priorRun = await getPackageCodemodRunById(
				ctx.env.APP_DB,
				args.revertOfRunId,
			)
			if (!priorRun) {
				throw new McpCallerError(
					`Package codemod run "${args.revertOfRunId}" was not found.`,
				)
			}
			if (
				priorRun.scopeUserId != null &&
				priorRun.scopeUserId !== user.userId
			) {
				throw new McpCallerError(
					`Package codemod run "${args.revertOfRunId}" is not scoped to the signed-in user.`,
				)
			}
			return await runPackageCodemodStep({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				initiatedByUserId: user.userId,
				codemodId: priorRun.codemodId,
				mode: 'revert',
				scope: { kind: 'user', userId: user.userId },
				runId: args.runId,
				cursor: args.cursor,
				limit: args.limit,
				revertOfRunId: args.revertOfRunId,
			})
		},
	},
)
