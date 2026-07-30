import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	packageCodemodPagingHint,
	packageCodemodStepInputSchema,
	packageCodemodStepResultSchema,
	runCallerPackageCodemodStep,
} from './package-codemod-shared.ts'

export const packageCodemodApplyCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_codemod_apply',
		description: `Apply a registered package codemod to the signed-in user’s saved packages: republishes transformed published trees after the same gates as dry-run. Prefer package_codemod_dry_run first. Keep the returned runId to revert with package_codemod_revert. ${packageCodemodPagingHint}`,
		keywords: [
			'package',
			'codemod',
			'apply',
			'migrate',
			'republish',
			'package codemod',
		],
		tags: ['codemod'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: packageCodemodStepInputSchema,
		outputSchema: packageCodemodStepResultSchema,
		async handler(args, ctx) {
			return await runCallerPackageCodemodStep(ctx, {
				codemodId: args.codemodId,
				mode: 'apply',
				packageIds: args.packageIds,
				runId: args.runId,
				cursor: args.cursor,
				limit: args.limit,
			})
		},
	},
)
