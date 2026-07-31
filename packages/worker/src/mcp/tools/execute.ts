import * as Sentry from '@sentry/cloudflare'
import {
	type ContentBlock,
	type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { z } from 'zod'
import { executeToolDescription } from '#mcp/instructions/execute-tool-description.ts'
import {
	defaultExecutionResponseLimitBytes,
	formatLimitedExecutionOutput,
	limitExecutionResultValue,
	formatExecutionOutput,
	getExecutionErrorDetails,
} from '#mcp/executor.ts'
import {
	defaultMcpContentLimitBytes,
	extractMcpPassthrough,
	limitMcpContentBlocks,
	validateDownstreamMcpContentBlocks,
} from '#mcp/downstream-mcp-result.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { runModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	callerContextFields,
	errorFields,
	logMcpEvent,
} from '#mcp/observability.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
	resolveConversationId,
} from './tool-call-context.ts'
import {
	buildMemoryRetrievalQuery,
	buildMemoryStructuredContent,
	formatSurfacedMemoriesMarkdown,
	surfaceToolMemories,
} from './memory-tool-context.ts'
import { finishToolTiming, startToolTiming } from './tool-timing.ts'
import { prependToolMetadataContent } from './tool-response-content.ts'
import {
	applyRawFetchHostCounts,
	codeUsesIntegrationAuthHelpers,
	createRawFetchHostSink,
	listHostsApproachingRawFetchNudge,
	readLiteralRequestHostname,
	type RawFetchHostNudgeState,
} from '#mcp/raw-fetch-host-nudge.ts'
import { listOpenApiBindings } from '#worker/openapi/binding-service.ts'
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'
import { consumeDailyEntitlement } from '#worker/entitlements/service.ts'
import { createExecutePackageInvokeTools } from '#worker/package-invocations/service.ts'
import {
	abandonRunRecord,
	claimRunRecord,
	finishRunRecord,
	getRunRecord,
	getRunRecordByIdempotencyKey,
} from '#worker/run-records/service.ts'
import {
	runRecordMaxIdempotencyKeyLength,
	type RunRecord,
	type RunRecordHandle,
} from '#worker/run-records/types.ts'

const executeTool = {
	name: 'execute',
	title: 'Execute Capabilities',
	description: executeToolDescription,
	annotations: {
		readOnlyHint: false,
		// Execute can delete, overwrite, send, revoke, or otherwise make
		// irreversible changes depending on the module and capabilities called.
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	} satisfies ToolAnnotations,
} as const

export async function registerExecuteTool(agent: McpRegistrationAgent) {
	agent.server.registerTool(
		executeTool.name,
		{
			title: executeTool.title,
			description: executeTool.description,
			inputSchema: {
				code: z
					.string()
					.describe(
						'Single ESM module string with imports/exports and a default export to execute. Imports may be arbitrary npm packages compatible with the Cloudflare Workers runtime; prefer packages over rewriting helpers.',
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
						'Optional durable storage id to bind to this execute call. Returned again in the structured response when active.',
					),
				writable: z
					.boolean()
					.optional()
					.describe(
						'Optional write access toggle for bound storage. Defaults to false for ad hoc execute calls.',
					),
				responseLimit: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe(
						`Soft cap on the JSON/text value returned from your default export (structured result / serialized output). Defaults to ~100 KB (${defaultExecutionResponseLimitBytes.toLocaleString()} bytes). Oversized JSON is truncated with a note. Protocol content blocks from __mcpContent (images/audio/resources) use a separate ~512 KB content cap and are not truncated into JSON text — oversized protocol content fails explicitly. Project large API payloads before returning. Examples:
// bad: messages.list().then(j => j) -- returns full Gmail payloads
// good: messages.list().then(j => j.messages.map(m => ({id: m.id, snippet: m.snippet})))
// good: aggregate().then(rows => ({count: rows.length, sample: rows.slice(0, 3)}))`,
					),
				conversationId: conversationIdInputField,
				memoryContext: memoryContextInputField,
				idempotencyKey: z
					.string()
					.min(1)
					.max(runRecordMaxIdempotencyKeyLength)
					.optional()
					.describe(
						`Optional caller-supplied idempotency key (max ${runRecordMaxIdempotencyKeyLength} chars). When set, the run is persisted eagerly (including successes) with a bounded result snapshot so a client-side MCP transport timeout can recover via run_get or by retrying the same key. Retries of a finished key return the retained result with replayed: true; retries while still running return inProgress: true with the runId — neither re-executes. Key-less execute stays on-failure-only (successes are not recorded).`,
					),
			},
			annotations: executeTool.annotations,
		},
		async ({
			code,
			params,
			storageId,
			writable,
			responseLimit,
			conversationId,
			memoryContext,
			idempotencyKey,
		}: {
			code: string
			params?: Record<string, unknown>
			storageId?: string
			writable?: boolean
			responseLimit?: number
			conversationId?: string
			memoryContext?: z.infer<typeof memoryContextInputField>
			idempotencyKey?: string
		}) => {
			const timingStart = startToolTiming()
			const env = agent.getEnv()
			// Hand terminal run-record writes and nested-invocation
			// observability to the Durable Object's waitUntil so they stop
			// serializing the execute response they observe.
			const waitUntil = agent.waitUntil?.bind(agent)
			const baseCallerContext = agent.getCallerContext()
			const resolvedStorageId = storageId?.trim() || null
			const callerContext = {
				...baseCallerContext,
				storageContext: {
					sessionId: baseCallerContext.storageContext?.sessionId ?? null,
					appId: baseCallerContext.storageContext?.appId ?? null,
					packageId: baseCallerContext.storageContext?.packageId ?? null,
					storageId:
						resolvedStorageId ??
						baseCallerContext.storageContext?.storageId ??
						null,
				},
			}
			const resolvedConversationId = resolveConversationId(conversationId)
			const {
				baseUrl,
				hasUser,
				userId,
				storageId: boundStorageId,
			} = callerContextFields(callerContext)
			const activeStorageId = boundStorageId ?? null
			const mcpCallerFields = {
				baseUrl,
				hasUser,
				userId,
				conversationId: resolvedConversationId,
				...(activeStorageId ? { storageId: activeStorageId } : {}),
			}
			let claimedRunHandle: RunRecordHandle | null = null
			try {
				return await runExecuteTool()
			} catch (cause) {
				// Setup failures (registry build, module bundling, executor
				// creation) must return a structured MCP error instead of an
				// unhandled rejection, mirroring the search tool boundary.
				// Finalize any pre-claimed keyed run so retries can replay the
				// error instead of seeing a stuck `running` row.
				// Nested-function assignments are invisible to TS control-flow
				// analysis on the outer `let`, so reassert the declared type.
				const claimedHandle = claimedRunHandle as RunRecordHandle | null
				// Setup failures happen before sandbox work: release the key so
				// a later retry is not poisoned by a non-sandbox error.
				if (claimedHandle) {
					await abandonRunRecord({ env, handle: claimedHandle })
				}
				const timing = finishToolTiming(timingStart)
				const error = cause instanceof Error ? cause : new Error(String(cause))
				const { errorName, errorMessage } = errorFields(error)
				logMcpEvent({
					category: 'mcp',
					tool: 'execute',
					toolName: 'execute',
					outcome: 'failure',
					durationMs: timing.durationMs,
					...mcpCallerFields,
					sandboxError: false,
					errorName,
					errorMessage,
					cause: error,
				})
				return {
					content: prependToolMetadataContent(resolvedConversationId, [
						{ type: 'text', text: `Error: ${error.message}` },
					]),
					structuredContent: {
						conversationId: resolvedConversationId,
						timing,
						error: error.message,
					},
					isError: true,
				}
			}

			async function runExecuteTool() {
				const normalizedIdempotencyKey =
					normalizeExecuteIdempotencyKey(idempotencyKey)
				// Look up an existing keyed execute run before consuming quota
				// so transport-timeout retries can replay / report in-progress
				// without burning another daily slot.
				if (normalizedIdempotencyKey && callerContext.user?.userId) {
					const existing = await getRunRecordByIdempotencyKey({
						env,
						userId: callerContext.user.userId,
						idempotencyKey: normalizedIdempotencyKey,
						surface: 'execute',
					})
					if (existing) {
						const timing = finishToolTiming(timingStart)
						return buildKeyedExecuteLookupResponse({
							run: existing,
							conversationId: resolvedConversationId,
							timing,
							activeStorageId,
						})
					}
				}

				// Daily execute quota, consumed before claim/bundling/sandbox
				// so over-limit calls cost nothing and do not poison a key.
				if (callerContext.user?.userId) {
					await consumeDailyEntitlement({
						db: env.APP_DB,
						userId: callerContext.user.userId,
						email: callerContext.user.email,
						resource: 'execute_calls_per_day',
					})
				}

				if (normalizedIdempotencyKey && callerContext.user?.userId) {
					const claim = await claimRunRecord({
						env,
						userId: callerContext.user.userId,
						context: {
							surface: 'execute',
							name: null,
							storageId: activeStorageId,
							idempotencyKey: normalizedIdempotencyKey,
							metadata: {
								conversationId: resolvedConversationId,
							},
						},
					})
					if (!claim) {
						throw new Error(
							'Unable to claim execute idempotency key; RUN_LOG is unavailable.',
						)
					}
					if (!claim.claimed) {
						const timing = finishToolTiming(timingStart)
						return buildKeyedExecuteLookupResponse({
							run: claim.run,
							conversationId: resolvedConversationId,
							timing,
							activeStorageId,
						})
					}
					claimedRunHandle = claim.handle
				}

				const [registry, surfacedMemories] = await Promise.all([
					getCapabilityRegistryForContext({
						env,
						callerContext,
					}),
					surfaceToolMemories({
						env,
						callerContext,
						conversationId: resolvedConversationId,
						retrievalQuery: buildMemoryRetrievalQuery(memoryContext),
					}),
				])
				const registeredCapabilityCount = Object.keys(
					registry.capabilityHandlers,
				).length
				const rawFetchHosts = createRawFetchHostSink()
				const result = await Sentry.startSpan(
					{
						name: 'mcp.tool.execute',
						op: 'mcp.tool',
						attributes: {
							'mcp.tool': 'execute',
						},
					},
					async () => {
						const packageInvokeTools = callerContext.user?.userId
							? await createExecutePackageInvokeTools({
									env,
									baseUrl: callerContext.baseUrl,
									callerContext,
									conversationId: resolvedConversationId,
									waitUntil,
								})
							: undefined
						try {
							return await runModuleWithRegistry(
								env,
								callerContext,
								code,
								params,
								{
									executorExports: agent.getLoopbackExports(),
									capabilityRegistry: registry,
									storageTools: activeStorageId
										? {
												userId: callerContext.user?.userId ?? '',
												storageId: activeStorageId,
												writable: writable ?? false,
											}
										: undefined,
									packageInvokeTools,
									rawFetchHostSink: rawFetchHosts.sink,
									conversationId: resolvedConversationId,
									runRecordHandle: claimedRunHandle,
									waitUntil,
									runRecord: {
										surface: 'execute',
										name: null,
										storageId: activeStorageId,
										idempotencyKey: normalizedIdempotencyKey,
										metadata: {
											conversationId: resolvedConversationId,
										},
									},
								},
							)
						} catch (cause) {
							// Bundling the caller-provided module (syntax errors,
							// unresolved imports) throws before the sandbox runs;
							// route it through the sandbox-error result path so it
							// is not logged as a platform failure. Finish a still-
							// running claimed row only — if the registry already
							// wrote a terminal row, do not double-finish.
							if (claimedRunHandle) {
								const current = await getRunRecord({
									env,
									userId: claimedRunHandle.userId,
									runId: claimedRunHandle.id,
								})
								if (current?.run.status === 'running') {
									await finishRunRecord({
										env,
										handle: claimedRunHandle,
										status: 'error',
										error: cause,
									})
								}
							}
							return {
								result: undefined,
								error: getErrorMessage(cause),
								logs: [],
								...(claimedRunHandle ? { runId: claimedRunHandle.id } : {}),
							}
						}
					},
				)
				const timing = {
					...finishToolTiming(timingStart),
					...(result.serverTiming && result.serverTiming.length > 0
						? { serverTiming: result.serverTiming }
						: {}),
				}
				const durationMs = timing.durationMs
				const rawFetchHostNudges = await resolveRawFetchHostNudges({
					agent,
					env,
					callerContext,
					conversationId: resolvedConversationId,
					hostCounts: rawFetchHosts.hostCounts(),
					usedIntegrationAuthHelpers: codeUsesIntegrationAuthHelpers(code),
				})
				const runId =
					typeof result.runId === 'string'
						? result.runId
						: (claimedRunHandle?.id ?? undefined)

				if (result.error) {
					const errorDetails = getExecutionErrorDetails(result.error)
					const { errorName, errorMessage } = errorFields(result.error)
					logMcpEvent({
						category: 'mcp',
						tool: 'execute',
						toolName: 'execute',
						outcome: 'failure',
						durationMs,
						...mcpCallerFields,
						registeredCapabilityCount,
						sandboxError: true,
						errorName,
						errorMessage,
						cause: result.error,
					})
					return {
						content: prependToolMetadataContent(resolvedConversationId, [
							{
								type: 'text',
								text: formatExecutionOutput(result),
							},
							...formatRawFetchHostNudgeContent(rawFetchHostNudges),
							...formatSurfacedMemoriesMarkdown(surfacedMemories),
						]),
						structuredContent: {
							conversationId: resolvedConversationId,
							timing,
							...(activeStorageId ? { storage: { id: activeStorageId } } : {}),
							...(runId ? { runId } : {}),
							returnedBytes: 0,
							error: errorMessage,
							errorDetails,
							logs: result.logs ?? [],
							...(rawFetchHostNudges.length > 0
								? { warnings: rawFetchHostNudges }
								: {}),
							...buildMemoryStructuredContent(surfacedMemories),
						},
						isError: true,
					}
				}

				logMcpEvent({
					category: 'mcp',
					tool: 'execute',
					toolName: 'execute',
					outcome: 'success',
					durationMs,
					...mcpCallerFields,
					registeredCapabilityCount,
					sandboxError: false,
					context: activeStorageId ? { storageId: activeStorageId } : undefined,
				})
				const responseLimitBytes =
					responseLimit ?? defaultExecutionResponseLimitBytes
				const passthrough = extractMcpPassthrough(result.result)
				const rawContent = passthrough?.content ?? null

				if (rawContent) {
					let validatedContent: Array<ContentBlock>
					try {
						validatedContent = validateDownstreamMcpContentBlocks(rawContent, {
							kind: 'execute',
							label: 'default export (__mcpContent)',
						})
					} catch (error) {
						const message = getErrorMessage(error)
						return {
							content: prependToolMetadataContent(resolvedConversationId, [
								{
									type: 'text',
									text: `Error: ${message}`,
								},
								...formatSurfacedMemoriesMarkdown(surfacedMemories),
							]),
							structuredContent: {
								conversationId: resolvedConversationId,
								timing,
								...(activeStorageId
									? { storage: { id: activeStorageId } }
									: {}),
								...(runId ? { runId } : {}),
								returnedBytes: 0,
								error: message,
								result: passthrough?.structuredResult ?? null,
								logs: result.logs ?? [],
								...buildMemoryStructuredContent(surfacedMemories),
							},
							isError: true,
						}
					}

					const contentLimited = limitMcpContentBlocks(
						validatedContent,
						defaultMcpContentLimitBytes,
					)
					if (!contentLimited.ok) {
						return {
							content: prependToolMetadataContent(resolvedConversationId, [
								{
									type: 'text',
									text: `Error: ${contentLimited.note}`,
								},
								...formatSurfacedMemoriesMarkdown(surfacedMemories),
							]),
							structuredContent: {
								conversationId: resolvedConversationId,
								timing,
								...(activeStorageId
									? { storage: { id: activeStorageId } }
									: {}),
								...(runId ? { runId } : {}),
								returnedBytes: contentLimited.returnedBytes,
								truncated: true,
								note: contentLimited.note,
								result: passthrough?.structuredResult ?? null,
								logs: result.logs ?? [],
								...buildMemoryStructuredContent(surfacedMemories),
							},
							isError: true,
						}
					}

					const companionLimited =
						passthrough?.structuredResult === undefined ||
						passthrough.structuredResult === null
							? null
							: limitExecutionResultValue(
									passthrough.structuredResult,
									responseLimitBytes,
								)

					return {
						content: prependToolMetadataContent(resolvedConversationId, [
							...contentLimited.blocks,
							...formatRawFetchHostNudgeContent(rawFetchHostNudges),
							...formatSurfacedMemoriesMarkdown(surfacedMemories),
						]),
						structuredContent: {
							conversationId: resolvedConversationId,
							timing,
							...(activeStorageId ? { storage: { id: activeStorageId } } : {}),
							...(runId ? { runId } : {}),
							returnedBytes:
								contentLimited.returnedBytes +
								(companionLimited?.returnedBytes ?? 0),
							...(companionLimited?.truncated
								? {
										truncated: true,
										note: companionLimited.note,
									}
								: {}),
							result: companionLimited
								? companionLimited.value
								: (passthrough?.structuredResult ?? null),
							logs: result.logs ?? [],
							...(rawFetchHostNudges.length > 0
								? { warnings: rawFetchHostNudges }
								: {}),
							...buildMemoryStructuredContent(surfacedMemories),
						},
						isError: passthrough?.isError ?? false,
					}
				}

				const limitedResult = limitExecutionResultValue(
					result.result,
					responseLimitBytes,
				)
				const markerOnlyPassthrough =
					passthrough &&
					(passthrough.isError || passthrough.structuredResult !== null)
						? passthrough
						: null
				const structuredResultValue = markerOnlyPassthrough
					? limitExecutionResultValue(
							markerOnlyPassthrough.structuredResult ?? {},
							responseLimitBytes,
						)
					: limitedResult

				return {
					content: prependToolMetadataContent(resolvedConversationId, [
						{
							type: 'text',
							text: formatLimitedExecutionOutput({
								value: structuredResultValue.value,
								truncated: structuredResultValue.truncated,
								note: structuredResultValue.note,
								displayText: structuredResultValue.displayText,
							}),
						},
						...formatRawFetchHostNudgeContent(rawFetchHostNudges),
						...formatSurfacedMemoriesMarkdown(surfacedMemories),
					]),
					structuredContent: {
						conversationId: resolvedConversationId,
						timing,
						...(activeStorageId ? { storage: { id: activeStorageId } } : {}),
						...(runId ? { runId } : {}),
						returnedBytes: structuredResultValue.returnedBytes,
						...(structuredResultValue.truncated
							? {
									truncated: true,
									note: structuredResultValue.note,
								}
							: {}),
						result: structuredResultValue.value,
						logs: result.logs ?? [],
						...(rawFetchHostNudges.length > 0
							? { warnings: rawFetchHostNudges }
							: {}),
						...buildMemoryStructuredContent(surfacedMemories),
					},
					isError: markerOnlyPassthrough?.isError ?? false,
				}
			}
		},
	)
}

function normalizeExecuteIdempotencyKey(
	value: string | undefined,
): string | null {
	const trimmed = value?.trim()
	if (!trimmed) return null
	return trimmed.slice(0, runRecordMaxIdempotencyKeyLength)
}

function buildKeyedExecuteLookupResponse(input: {
	run: RunRecord
	conversationId: string
	timing: {
		startedAt: string
		endedAt: string
		durationMs: number
	}
	activeStorageId: string | null
}) {
	const storage = input.activeStorageId
		? { storage: { id: input.activeStorageId } }
		: {}
	if (input.run.status === 'running') {
		return {
			content: prependToolMetadataContent(input.conversationId, [
				{
					type: 'text',
					text: `Execute still in progress (runId: ${input.run.id}). Poll run_get with that id, or retry with the same idempotencyKey.`,
				},
			]),
			structuredContent: {
				conversationId: input.conversationId,
				timing: input.timing,
				...storage,
				runId: input.run.id,
				inProgress: true,
				status: 'running' as const,
			},
			isError: false,
		}
	}

	const retainedResult = input.run.metadata['result']
	if (input.run.status === 'error') {
		const errorMessage =
			input.run.errorMessage ?? 'Execute failed (replayed from run record).'
		return {
			content: prependToolMetadataContent(input.conversationId, [
				{
					type: 'text',
					text: `Error: ${errorMessage}`,
				},
			]),
			structuredContent: {
				conversationId: input.conversationId,
				timing: input.timing,
				...storage,
				runId: input.run.id,
				replayed: true,
				returnedBytes: 0,
				error: errorMessage,
				...(input.run.errorName ? { errorName: input.run.errorName } : {}),
				...(retainedResult !== undefined ? { result: retainedResult } : {}),
				logs: [] as Array<unknown>,
			},
			isError: true,
		}
	}

	return {
		content: prependToolMetadataContent(input.conversationId, [
			{
				type: 'text',
				text: formatLimitedExecutionOutput({
					value: retainedResult,
					truncated: false,
					note: undefined,
					displayText: undefined,
				}),
			},
		]),
		structuredContent: {
			conversationId: input.conversationId,
			timing: input.timing,
			...storage,
			runId: input.run.id,
			replayed: true,
			returnedBytes: 0,
			result: retainedResult,
			logs: [] as Array<unknown>,
		},
		isError: false,
	}
}

function formatRawFetchHostNudgeContent(nudges: Array<string>) {
	if (nudges.length === 0) return []
	return [
		{
			type: 'text' as const,
			text: nudges.join('\n'),
		},
	]
}

async function resolveRawFetchHostNudges(input: {
	agent: McpRegistrationAgent
	env: Env
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
	conversationId: string
	hostCounts: ReadonlyMap<string, number>
	usedIntegrationAuthHelpers?: boolean
}): Promise<Array<string>> {
	if (input.hostCounts.size === 0) return []

	const statefulAgent = input.agent as McpRegistrationAgent & {
		state?: {
			rawFetchHostNudges?: RawFetchHostNudgeState
		}
		setState?: (state: {
			rawFetchHostNudges?: RawFetchHostNudgeState
			[key: string]: unknown
		}) => void
	}
	const approaching = listHostsApproachingRawFetchNudge({
		state: statefulAgent.state?.rawFetchHostNudges,
		conversationId: input.conversationId,
		hostCounts: input.hostCounts,
	})
	const coveredHosts =
		approaching.length > 0
			? await listOpenApiBindingHosts({
					env: input.env,
					callerContext: input.callerContext,
				})
			: new Set<string>()
	const applied = applyRawFetchHostCounts({
		state: statefulAgent.state?.rawFetchHostNudges,
		conversationId: input.conversationId,
		hostCounts: input.hostCounts,
		coveredHosts,
		usedIntegrationAuthHelpers: input.usedIntegrationAuthHelpers,
	})
	if (typeof statefulAgent.setState === 'function') {
		statefulAgent.setState({
			...(statefulAgent.state ?? {}),
			rawFetchHostNudges: applied.state,
		})
	}
	return applied.nudges
}

async function listOpenApiBindingHosts(input: {
	env: Env
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
}): Promise<Set<string>> {
	const userId = input.callerContext.user?.userId
	if (!userId) return new Set()
	try {
		const bindings = await listOpenApiBindings({
			env: input.env,
			userId,
		})
		const hosts = new Set<string>()
		for (const binding of bindings) {
			const hostname = normalizeHost(
				readLiteralRequestHostname(binding.apiBaseUrl),
			)
			if (hostname) hosts.add(hostname)
		}
		return hosts
	} catch {
		// Binding lookup is best-effort on this hot path; skip exclusion rather
		// than failing the execute response.
		return new Set()
	}
}
