import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	assertWithinEntitlement,
	countRunningPackageServices,
} from '#worker/entitlements/service.ts'
import {
	requirePackageServiceContext,
	resolveDeclaredPackageService,
} from './shared.ts'

const inputSchema = z.object({
	service_name: z.string().trim().min(1),
	package_id: z.string().min(1).optional(),
})

const outputSchema = z.object({
	ok: z.boolean(),
	run_id: z.string().optional(),
	started_at: z.string().optional(),
	status: z.enum(['running']).optional(),
	already_running: z.boolean().optional(),
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
			const currentStatus = await serviceContext.service.status()
			if (currentStatus.status !== 'running') {
				const declaredService = await resolveDeclaredPackageService({
					env: ctx.env,
					callerContext: ctx.callerContext,
					savedPackage: serviceContext.savedPackage,
					userId: serviceContext.user.userId,
					serviceName: args.service_name,
				})
				if (declaredService?.mode === 'persistent') {
					await assertWithinEntitlement({
						db: ctx.env.APP_DB,
						userId: serviceContext.user.userId,
						email: serviceContext.user.email,
						resource: 'persistent_package_services',
					})
				}
				await assertWithinEntitlement({
					db: ctx.env.APP_DB,
					userId: serviceContext.user.userId,
					email: serviceContext.user.email,
					resource: 'package_services',
					// Exclude this service from the running count so a stale
					// 'running' telemetry row for it can never block its own
					// restart.
					getCurrent: async () =>
						await countRunningPackageServices({
							env: ctx.env,
							userId: serviceContext.user.userId,
							excludeService: {
								packageId: serviceContext.savedPackage.id,
								serviceName: args.service_name,
							},
						}),
				})
			}
			return await serviceContext.service.start()
		},
	},
)
