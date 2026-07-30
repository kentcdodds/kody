import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	packageCodemodPagingHint,
	packageCodemodStepInputSchema,
	packageCodemodStepResultSchema,
	runCallerPackageCodemodStep,
} from './package-codemod-shared.ts'

export const packageCodemodDryRunCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_codemod_dry_run',
		description: `Dry-run a registered package codemod on the signed-in user’s saved packages: transform in memory and run publish checks without writing. ${packageCodemodPagingHint}`,
		keywords: [
			'package',
			'codemod',
			'dry-run',
			'preview',
			'migration',
			'package codemod',
		],
		tags: ['codemod'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: packageCodemodStepInputSchema,
		outputSchema: packageCodemodStepResultSchema,
		async handler(args, ctx) {
			return await runCallerPackageCodemodStep(ctx, {
				codemodId: args.codemodId,
				mode: 'dry-run',
				packageIds: args.packageIds,
				runId: args.runId,
				cursor: args.cursor,
				limit: args.limit,
			})
		},
	},
)
