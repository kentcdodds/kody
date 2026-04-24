import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	listPackageServicesForContext,
	packageServiceSummarySchema,
	normalizePackageServiceStatus,
} from './shared.ts'

const inputSchema = z.object({
	package_id: z.string().min(1).optional(),
})

const outputSchema = z.object({
	package_id: z.string(),
	kody_id: z.string(),
	services: z.array(packageServiceSummarySchema),
})

export const serviceListCapability = defineDomainCapability(
	capabilityDomainNames.services,
	{
		name: 'service_list',
		description:
			'List package services declared by a saved package, including their current runtime status.',
		keywords: ['service', 'services', 'package', 'list', 'status'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const listed = await listPackageServicesForContext({
				env: ctx.env,
				callerContext: ctx.callerContext,
				explicitPackageId: args.package_id,
			})
			const services = await Promise.all(
				listed.services.map(async (service) => {
					const status = normalizePackageServiceStatus(await listed.rpc(service.name).status())
					return {
						name: service.name,
						entry: service.entry,
						auto_start: service.auto_start,
						status: status.status,
					}
				}),
			)
			return {
				package_id: listed.savedPackage.id,
				kody_id: listed.savedPackage.kodyId,
				services,
			}
		},
	},
)
