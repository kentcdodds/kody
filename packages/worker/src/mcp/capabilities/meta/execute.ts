import { z } from 'zod'
import {
	defaultExecutionResponseLimitBytes,
	getExecutionErrorDetails,
	limitExecutionResultValue,
} from '#mcp/executor.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { getErrorMessage } from '#mcp/capabilities/error-message.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
	resolveConversationId,
} from '#mcp/tools/tool-call-context.ts'

const storageOutputSchema = z.object({
	id: z.string(),
})

const executeOutputSchema = z.object({
	ok: z.boolean(),
	conversationId: z.string(),
	storage: storageOutputSchema.optional(),
	returnedBytes: z.number().int().nonnegative().optional(),
	truncated: z.boolean().optional(),
	note: z.string().optional(),
	result: z.unknown().optional(),
	error: z.string().optional(),
	errorDetails: z.unknown().optional(),
	logs: z.array(z.unknown()),
})

export const executeCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'execute',
		description:
			'Run one ephemeral ESM module string with a default export inside the Kody execute runtime. Use this inside package and execute runtimes when reusable code needs to call the same module execution surface as the public MCP execute tool.',
		keywords: ['execute', 'kody', 'module', 'sandbox', 'runtime'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			code: z
				.string()
				.min(1)
				.describe(
					'Single ESM module string with imports/exports and a default export to execute.',
				),
			params: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					'Optional JSON params passed as the first argument to the module default export at execution time.',
				),
			storageId: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional durable storage id to bind to this execute call. Defaults to the caller context storage id when present.',
				),
			writable: z
				.boolean()
				.optional()
				.describe(
					'Optional write access toggle for bound storage. Defaults to false.',
				),
			responseLimit: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe(
					'Soft cap on the size of the value returned from the module default export.',
				),
			conversationId: conversationIdInputField,
			memoryContext: memoryContextInputField,
		}),
		outputSchema: executeOutputSchema,
		async handler(
			args: {
				code: string
				params?: Record<string, unknown>
				storageId?: string
				writable?: boolean
				responseLimit?: number
				conversationId?: string
			},
			ctx: CapabilityContext,
		) {
			const resolvedStorageId =
				args.storageId?.trim() ||
				ctx.callerContext.storageContext?.storageId ||
				null
			const callerContext = {
				...ctx.callerContext,
				storageContext: {
					sessionId: ctx.callerContext.storageContext?.sessionId ?? null,
					appId: ctx.callerContext.storageContext?.appId ?? null,
					storageId: resolvedStorageId,
				},
			}
			const conversationId = resolveConversationId(args.conversationId)
			const { runModuleWithRegistry } =
				await import('#mcp/run-kody-registry.ts')
			const result = await runModuleWithRegistry(
				ctx.env,
				callerContext,
				args.code,
				args.params,
				{
					storageTools: resolvedStorageId
						? {
								userId: callerContext.user?.userId ?? '',
								storageId: resolvedStorageId,
								writable: args.writable ?? false,
							}
						: undefined,
				},
			)
			const logs = result.logs ?? []
			const storage = resolvedStorageId ? { id: resolvedStorageId } : undefined

			if (result.error) {
				return {
					ok: false,
					conversationId,
					...(storage ? { storage } : {}),
					error: getErrorMessage(result.error),
					errorDetails: getExecutionErrorDetails(result.error),
					logs,
				}
			}

			const limitedResult = limitExecutionResultValue(
				result.result,
				args.responseLimit ?? defaultExecutionResponseLimitBytes,
			)
			return {
				ok: true,
				conversationId,
				...(storage ? { storage } : {}),
				returnedBytes: limitedResult.returnedBytes,
				...(limitedResult.truncated
					? {
							truncated: true,
							note: limitedResult.note,
						}
					: {}),
				result: limitedResult.value,
				logs,
			}
		},
	},
)
