import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { z } from 'zod'
import {
	packageServiceStatusSchema,
	requirePackageServiceContext,
} from './shared.ts'

export const serviceGetCapability = defineDomainCapability(
	capabilityDomainNames.services,
	{
		name: 'service_get',
		description:
			'Get status for one package service declared under package.json#kody.services.',
		keywords: ['service', 'status', 'package', 'inspect'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			service_name: z.string().min(1),
			package_id: z.string().min(1).optional(),
		}),
		outputSchema: packageServiceStatusSchema,
		async handler(args, ctx) {
			const serviceContext = await requirePackageServiceContext({
				env: ctx.env,
				callerContext: ctx.callerContext,
				serviceName: args.service_name,
				explicitPackageId: args.package_id,
			})
			if (!serviceContext.service) {
				throw new Error(
					`Package service "${args.service_name}" was not found.`,
				)
			}
			return await serviceContext.service.status()
		},
	},
)
