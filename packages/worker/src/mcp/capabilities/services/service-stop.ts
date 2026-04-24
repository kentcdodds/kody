import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requirePackageServiceContext } from './shared.ts'

const inputSchema = z.object({
	service_name: z.string().min(1),
	package_id: z.string().min(1).optional(),
})

const outputSchema = z.object({
	ok: z.boolean(),
})

export const serviceStopCapability = defineDomainCapability(
	capabilityDomainNames.services,
	{
		name: 'service_stop',
		description: 'Stop one declared package service instance.',
		keywords: ['service', 'stop', 'package'],
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
			const result = (await serviceContext.service?.stop()) as { ok?: unknown }
			return {
				ok: result?.ok === true,
			}
		},
	},
)
