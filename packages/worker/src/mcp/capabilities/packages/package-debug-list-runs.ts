import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listPackageRuntimeRuns } from '#worker/package-runtime/package-runtime-debug.ts'
import {
	formatPackageRuntimeRun,
	packageRuntimeRunSchema,
	packageRuntimeSurfaceSchema,
} from './package-debug-shared.ts'

const inputSchema = z.object({
	package_id: z.string().min(1).optional(),
	surface: packageRuntimeSurfaceSchema.optional(),
	limit: z.number().int().positive().max(100).optional(),
})

const outputSchema = z.object({
	runs: z.array(packageRuntimeRunSchema),
})

export const packageDebugListRunsCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_debug_list_runs',
		description:
			'List recent retained runtime runs for live package exports, apps, services, jobs, workflows, subscriptions, and retrievers.',
		keywords: ['package', 'debug', 'logs', 'runs', 'observability', 'trace'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const packageId =
				args.package_id ?? ctx.callerContext.storageContext?.appId ?? null
			const runs = await listPackageRuntimeRuns({
				env: ctx.env,
				userId: user.userId,
				packageId,
				surface: args.surface ?? null,
				limit: args.limit ?? 25,
			})
			return {
				runs: runs.map(formatPackageRuntimeRun),
			}
		},
	},
)
