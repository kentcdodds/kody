import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminPackageCodemodStepInputSchema,
	packageCodemodPagingHint,
	packageCodemodStepResultSchema,
	runFleetPackageCodemodStep,
} from '#mcp/capabilities/packages/package-codemod-shared.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

export const adminPackageCodemodScanCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'admin_package_codemod_scan',
		description: `Fleet-scan saved packages for matches of a registered package codemod (detect only; no writes). Optional filters canary by userIds or packageIds. ${packageCodemodPagingHint}`,
		keywords: [
			'admin',
			'package',
			'codemod',
			'scan',
			'detect',
			'fleet',
			'migration',
			'package codemod',
		],
		tags: ['codemod'],
		inputSchema: adminPackageCodemodStepInputSchema,
		outputSchema: packageCodemodStepResultSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'admin_package_codemod_scan',
				async () =>
					await runFleetPackageCodemodStep(ctx, {
						codemodId: args.codemodId,
						mode: 'scan',
						packageIds: args.packageIds,
						filters: args.filters,
						runId: args.runId,
						cursor: args.cursor,
						limit: args.limit,
					}),
				{
					successReason: (result) =>
						`codemod=${result.codemodId};run=${result.runId}`,
				},
			)
		},
	},
)
