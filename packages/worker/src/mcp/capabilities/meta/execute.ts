import { z } from 'zod'
import { type ExecuteResult } from '@cloudflare/codemode'
import {
	defaultExecutionResponseLimitBytes,
	getExecutionErrorDetails,
	limitExecutionResultValue,
} from '#mcp/executor.ts'
import { resolveCallerFeatureFlags } from '#mcp/capabilities/access-control.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { runModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
	resolveConversationId,
} from '#mcp/tools/tool-call-context.ts'
import {
	abandonRunRecord,
	claimRunRecord,
	finishRunRecord,
	getRunRecord,
	getRunRecordByIdempotencyKey,
} from '#worker/run-records/service.ts'
import {
	runRecordMaxIdempotencyKeyLength,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'

const storageOutputSchema = z.object({
	id: z.string(),
})

const executeOutputSchema = z.object({
	ok: z.boolean(),
	conversationId: z.string(),
	storage: storageOutputSchema.optional(),
	runId: z.string().optional(),
	replayed: z.boolean().optional(),
	inProgress: z.boolean().optional(),
	status: z.enum(['running', 'success', 'error']).optional(),
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
			idempotencyKey: z
				.string()
				.min(1)
				.max(runRecordMaxIdempotencyKeyLength)
				.optional()
				.describe(
					`Optional caller-supplied idempotency key (max ${runRecordMaxIdempotencyKeyLength} chars). When set, persist the run eagerly with a bounded result snapshot and replay finished/in-progress outcomes instead of re-executing. Key-less execute stays on-failure-only.`,
				),
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
				idempotencyKey?: string
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
					packageId: ctx.callerContext.storageContext?.packageId ?? null,
					storageId: resolvedStorageId,
				},
			}
			const conversationId = resolveConversationId(args.conversationId)
			const storage = resolvedStorageId ? { id: resolvedStorageId } : undefined
			const idempotencyKey = args.idempotencyKey?.trim() || null
			const userId = callerContext.user?.userId ?? null

			if (idempotencyKey && userId) {
				const existing = await getRunRecordByIdempotencyKey({
					env: ctx.env,
					userId,
					idempotencyKey,
					surface: 'execute',
				})
				if (existing) {
					if (existing.status === 'running') {
						return {
							// Match the public execute tool: in-progress is not a
							// failure — callers should poll run_get / retry the key.
							ok: true,
							conversationId,
							...(storage ? { storage } : {}),
							runId: existing.id,
							inProgress: true,
							status: 'running' as const,
							logs: [],
						}
					}
					const retained = existing.metadata['result']
					if (existing.status === 'error') {
						return {
							ok: false,
							conversationId,
							...(storage ? { storage } : {}),
							runId: existing.id,
							replayed: true,
							status: 'error' as const,
							error:
								existing.errorMessage ??
								'Execute failed (replayed from run record).',
							...(retained !== undefined ? { result: retained } : {}),
							logs: [],
						}
					}
					return {
						ok: true,
						conversationId,
						...(storage ? { storage } : {}),
						runId: existing.id,
						replayed: true,
						status: 'success' as const,
						result: retained,
						logs: [],
					}
				}
			}

			let claimedRunHandle: RunRecordHandle | null = null
			if (idempotencyKey && userId) {
				const claim = await claimRunRecord({
					env: ctx.env,
					userId,
					context: {
						surface: 'execute',
						name: null,
						storageId: resolvedStorageId,
						idempotencyKey,
						metadata: { conversationId },
					},
				})
				if (!claim) {
					return {
						ok: false,
						conversationId,
						...(storage ? { storage } : {}),
						error:
							'Unable to claim execute idempotency key; RUN_LOG is unavailable.',
						logs: [],
					}
				}
				if (!claim.claimed) {
					if (claim.run.status === 'running') {
						return {
							ok: true,
							conversationId,
							...(storage ? { storage } : {}),
							runId: claim.run.id,
							inProgress: true,
							status: 'running' as const,
							logs: [],
						}
					}
					const retained = claim.run.metadata['result']
					if (claim.run.status === 'error') {
						return {
							ok: false,
							conversationId,
							...(storage ? { storage } : {}),
							runId: claim.run.id,
							replayed: true,
							status: 'error' as const,
							error:
								claim.run.errorMessage ??
								'Execute failed (replayed from run record).',
							...(retained !== undefined ? { result: retained } : {}),
							logs: [],
						}
					}
					return {
						ok: true,
						conversationId,
						...(storage ? { storage } : {}),
						runId: claim.run.id,
						replayed: true,
						status: 'success' as const,
						result: retained,
						logs: [],
					}
				}
				claimedRunHandle = claim.handle
			}

			let result: ExecuteResult & { runId?: string }
			try {
				const featureFlags = await resolveCallerFeatureFlags(
					ctx.env,
					callerContext,
				)
				result = await runModuleWithRegistry(
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
						preExecTypecheck:
							featureFlags['execute-pre-exec-typecheck'] === true,
						runRecordHandle: claimedRunHandle,
						runRecord: {
							surface: 'execute',
							name: null,
							storageId: resolvedStorageId,
							idempotencyKey,
							metadata: { conversationId },
						},
					},
				)
			} catch (cause) {
				if (claimedRunHandle) {
					const current = await getRunRecord({
						env: ctx.env,
						userId: claimedRunHandle.userId,
						runId: claimedRunHandle.id,
					})
					if (current?.run.status === 'running') {
						await finishRunRecord({
							env: ctx.env,
							handle: claimedRunHandle,
							status: 'error',
							error: cause,
						})
					} else if (!current) {
						await abandonRunRecord({
							env: ctx.env,
							handle: claimedRunHandle,
						})
					}
				}
				return {
					ok: false,
					conversationId,
					...(storage ? { storage } : {}),
					...(claimedRunHandle ? { runId: claimedRunHandle.id } : {}),
					error: getErrorMessage(cause),
					errorDetails: getExecutionErrorDetails(cause),
					logs: [],
				}
			}
			const logs = result.logs ?? []
			const runId =
				typeof result.runId === 'string'
					? result.runId
					: (claimedRunHandle?.id ?? undefined)

			if (result.error) {
				return {
					ok: false,
					conversationId,
					...(storage ? { storage } : {}),
					...(runId ? { runId } : {}),
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
				...(runId ? { runId } : {}),
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
