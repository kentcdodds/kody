import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	assertWithinEntitlement,
	countRunningPackageServices,
} from '#worker/entitlements/service.ts'
import {
	requireDeclaredPackageService,
	requirePackageServiceContext,
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
			'Start a package service declared under package.json#kody.services and return the latest execution result.',
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
				throw new McpCallerError(
					`Package service "${args.service_name}" was not found for this package.`,
				)
			}
			// Validate the manifest declaration before RPC so typos / export-vs-
			// service mixups stay on McpCallerError instead of bubbling from the
			// Durable Object as an unhandled platform Error (Sentry noise).
			const declaredService = await requireDeclaredPackageService({
				env: ctx.env,
				callerContext: ctx.callerContext,
				savedPackage: serviceContext.savedPackage,
				userId: serviceContext.user.userId,
				serviceName: args.service_name,
			})
			const currentStatus = await serviceContext.service.status()
			if (currentStatus.status !== 'running') {
				if (declaredService.mode === 'persistent') {
					await assertWithinEntitlement({
						db: ctx.env.APP_DB,
						userId: serviceContext.user.userId,
						email: serviceContext.user.email,
						resource: 'persistent_package_services',
						getCurrent: async () =>
							await countRunningPackageServices({
								env: ctx.env,
								userId: serviceContext.user.userId,
								mode: 'persistent',
								excludeService: {
									packageId: serviceContext.savedPackage.id,
									serviceName: args.service_name,
								},
							}),
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
