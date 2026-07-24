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
		}: {
			code: string
			params?: Record<string, unknown>
			storageId?: string
			writable?: boolean
			responseLimit?: number
			conversationId?: string
			memoryContext?: z.infer<typeof memoryContextInputField>
		}) => {
			const timingStart = startToolTiming()
			const env = agent.getEnv()
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
			const { baseUrl, hasUser, userId, storageContext } =
				callerContextFields(callerContext)
			const activeStorageId = storageContext?.storageId ?? null
			try {
				return await runExecuteTool()
			} catch (cause) {
				// Setup failures (registry build, module bundling, executor
				// creation) must return a structured MCP error instead of an
				// unhandled rejection, mirroring the search tool boundary.
				const timing = finishToolTiming(timingStart)
				const error = cause instanceof Error ? cause : new Error(String(cause))
				const { errorName, errorMessage } = errorFields(error)
				logMcpEvent({
					category: 'mcp',
					tool: 'execute',
					toolName: 'execute',
					outcome: 'failure',
					durationMs: timing.durationMs,
					baseUrl,
					hasUser,
					userId,
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
				const { getCapabilityRegistryForContext } =
					await import('#mcp/capabilities/registry.ts')
				const registry = await getCapabilityRegistryForContext({
					env,
					callerContext,
				})
				const surfacedMemories = await surfaceToolMemories({
					env,
					callerContext,
					conversationId: resolvedConversationId,
					retrievalQuery: buildMemoryRetrievalQuery(memoryContext),
				})
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
							? await import('#worker/package-invocations/service.ts').then(
									({ createExecutePackageInvokeTools }) =>
										createExecutePackageInvokeTools({
											env,
											baseUrl: callerContext.baseUrl,
											callerContext,
											conversationId: resolvedConversationId,
										}),
								)
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
								},
							)
						} catch (cause) {
							// Bundling the caller-provided module (syntax errors,
							// unresolved imports) throws before the sandbox runs;
							// route it through the sandbox-error result path so it
							// is not logged as a platform failure.
							return {
								result: undefined,
								error: getErrorMessage(cause),
								logs: [],
							}
						}
					},
				)
				const timing = finishToolTiming(timingStart)
				const durationMs = timing.durationMs
				const rawFetchHostNudges = await resolveRawFetchHostNudges({
					agent,
					env,
					callerContext,
					conversationId: resolvedConversationId,
					hostCounts: rawFetchHosts.hostCounts(),
					usedIntegrationAuthHelpers: codeUsesIntegrationAuthHelpers(code),
				})

				if (result.error) {
					const errorDetails = getExecutionErrorDetails(result.error)
					const { errorName, errorMessage } = errorFields(result.error)
					logMcpEvent({
						category: 'mcp',
						tool: 'execute',
						toolName: 'execute',
						outcome: 'failure',
						durationMs,
						baseUrl,
						hasUser,
						userId,
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
					baseUrl,
					hasUser,
					userId,
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
			storageContext: {
				sessionId: input.callerContext.storageContext?.sessionId ?? null,
				appId: input.callerContext.storageContext?.appId ?? null,
				storageId: input.callerContext.storageContext?.storageId ?? null,
			},
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
