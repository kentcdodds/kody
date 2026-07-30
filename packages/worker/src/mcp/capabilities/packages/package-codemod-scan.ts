import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	packageCodemodPagingHint,
	packageCodemodStepInputSchema,
	packageCodemodStepResultSchema,
	runCallerPackageCodemodStep,
} from './package-codemod-shared.ts'

export const packageCodemodScanCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_codemod_scan',
		description: `Scan the signed-in user’s saved packages for matches of a registered package codemod (detect only; no writes). ${packageCodemodPagingHint}`,
		keywords: [
			'package',
			'codemod',
			'scan',
			'detect',
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
				mode: 'scan',
				packageIds: args.packageIds,
				runId: args.runId,
				cursor: args.cursor,
				limit: args.limit,
			})
		},
	},
)
