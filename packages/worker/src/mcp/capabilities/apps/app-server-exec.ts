import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	execSavedAppRunnerServer,
	syncSavedAppRunnerFromDb,
} from '#mcp/app-runner.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'

const inputSchema = z.object({
	app_id: z.string().min(1).describe('Saved app id to execute code against.'),
	code: z
		.string()
		.min(1)
		.describe(
			'One-off JavaScript function body compiled into a throwaway Dynamic Worker. The body receives `app` (alias `appStub`) as an RPC stub to the saved app facet plus `params` for JSON inputs.',
		),
	facet_name: z
		.string()
		.min(1)
		.optional()
		.describe('Optional saved app facet name. Defaults to `main`.'),
	params: z
		.record(z.string(), z.unknown())
		.optional()
		.describe('Optional JSON params passed to the debug code.'),
})

const outputSchema = z.object({
	ok: z.literal(true),
	app_id: z.string(),
	facet_name: z.string(),
	result: z.unknown(),
})

export const appServerExecCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'app_server_exec',
		description:
			'Compile and run one-off JavaScript in a throwaway Dynamic Worker with an explicit RPC stub to a saved app facet. Use this for debugging, repair tasks, or data migrations that call methods the saved app App class already exposes.',
		keywords: ['app', 'server', 'facet', 'debug', 'migration', 'exec'],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const artifact = await syncSavedAppRunnerFromDb({
				env: ctx.env,
				appId: args.app_id,
				userId: user.userId,
				baseUrl: ctx.callerContext.baseUrl,
			})
			if (!artifact) {
				throw new Error('Saved app not found for this user.')
			}
			const result = await execSavedAppRunnerServer({
				env: ctx.env,
				appId: args.app_id,
				facetName: args.facet_name ?? 'main',
				code: args.code,
				params: args.params,
			})
			return {
				ok: true as const,
				app_id: result.appId,
				facet_name: result.facetName,
				result: result.result,
			}
		},
	},
)
