import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { verifyGeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'

const inputSchema = z.object({
	token: z.string().min(1),
	code: z.string().min(1),
	params: z.record(z.string(), z.unknown()).optional(),
})

export const uiGeneratedUiInvokeActionCapability = defineDomainCapability(
	capabilityDomainNames.apps,
	{
		name: 'generated_ui_invoke_action',
		description:
			'Invoke a generated UI action using a session token so sandboxed UI code can execute codemode without direct bearer access.',
		keywords: ['generated ui', 'action', 'session', 'codemode'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema: z.object({
			ok: z.boolean(),
			result: z.unknown().nullable().optional(),
			logs: z.array(z.string()).optional(),
			error: z.string().optional(),
		}),
		async handler(args, ctx: CapabilityContext) {
			if (!ctx.callerContext.baseUrl) {
				throw new Error('Generated UI actions require a base URL.')
			}
			let session: Awaited<ReturnType<typeof verifyGeneratedUiAppSession>>
			try {
				session = await verifyGeneratedUiAppSession(ctx.env, args.token)
			} catch (error) {
				return {
					ok: false,
					error:
						error instanceof Error ? error.message : 'Invalid session token.',
					logs: [],
				}
			}
			const { runCodemodeWithRegistry } =
				await import('#mcp/run-codemode-registry.ts')
			const callerContext = {
				...ctx.callerContext,
				baseUrl: ctx.callerContext.baseUrl,
				user: session.user,
				homeConnectorId: 'default',
			}
			const execution = await runCodemodeWithRegistry(
				ctx.env,
				callerContext,
				args.code,
				args.params,
			)
			if (execution.error) {
				return {
					ok: false,
					error: String(execution.error),
					logs: execution.logs ?? [],
				}
			}
			return {
				ok: true,
				result: execution.result ?? null,
				logs: execution.logs ?? [],
			}
		},
	},
)
