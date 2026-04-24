import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requirePackageServiceContext } from './shared.ts'

const inputSchema = z.object({
	service_name: z.string().trim().min(1),
	package_id: z.string().min(1).optional(),
})

const outputSchema = z.object({
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
	started_at: z.string().optional(),
	finished_at: z.string().optional(),
})

export const serviceStartCapability = defineDomainCapability(
	capabilityDomainNames.services,
	{
		name: 'service_start',
		description:
			'Start a package service instance and return the latest execution result.',
		keywords: ['service', 'start', 'package service', 'runtime'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const serviceContext = await requirePackageServiceContext({
				env: ctx.env,
				callerContext: ctx.callerContext,
				serviceName: args.service_name,
				explicitPackageId: args.package_id,
			})
			if (!serviceContext.service) {
				throw new Error(
					`Package service "${args.service_name}" was not found for this package.`,
				)
			}
			return await serviceContext.service.start()
		},
	},
)
