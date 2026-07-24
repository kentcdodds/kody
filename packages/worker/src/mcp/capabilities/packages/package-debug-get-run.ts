import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getPackageRuntimeRun } from '#worker/package-runtime/package-runtime-debug.ts'
import {
	formatPackageRuntimeLog,
	formatPackageRuntimeRun,
	packageRuntimeLogSchema,
	packageRuntimeRunSchema,
} from './package-debug-shared.ts'

const inputSchema = z.object({
	run_id: z.string().min(1),
})

const outputSchema = z.object({
	run: packageRuntimeRunSchema,
	logs: z.array(packageRuntimeLogSchema),
})

export const packageDebugGetRunCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'package_debug_get_run',
		description:
			'Load a retained package runtime run with its captured logs and normalized error details.',
		keywords: ['package', 'debug', 'logs', 'run', 'trace', 'error'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const result = await getPackageRuntimeRun({
				env: ctx.env,
				userId: user.userId,
				runId: args.run_id,
			})
			if (!result) {
				throw new McpCallerError(
					`Package runtime run "${args.run_id}" was not found.`,
				)
			}
			return {
				run: formatPackageRuntimeRun(result.run),
				logs: result.logs.map(formatPackageRuntimeLog),
			}
		},
	},
)
