import * as Sentry from '@sentry/cloudflare'
import {
	type ContentBlock,
	type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { z } from 'zod'
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
	description: `
Run one ephemeral ESM module string with a default export. Imports may be arbitrary npm packages compatible with the Cloudflare Workers runtime (e.g. \`p-retry\`, \`mailparser\`, \`remark\`); prefer existing packages over rewriting helpers. Discover capability names with \`search\`; for one capability’s executable snippet and TypeScript call shape, call \`search\` with \`entity: "{name}:capability"\` or use \`meta_list_capabilities\`.

Projection rule: you write the code -- if a call returns a large response, project the fields you need before returning. Never return raw API responses; extract a slim shape (e.g. \`{ id, subject, snippet }\`) or a summary.

Sandbox surface:
- Import runtime helpers from \`kody:runtime\`.
- \`import { kody } from 'kody:runtime'\` for builtin capabilities discovered by \`search\`; call valid identifier names as \`await kody.capability_id(input)\`. If a capability id is not a valid JavaScript identifier, use bracket notation: \`await kody["capability-id"](input)\`. Capability detail from \`search({ entity: "{name}:capability" })\` includes the exact snippet.
- Remote connector, user-added MCP server, and curated OpenAPI capabilities use namespaced accessors: \`await kody.remote["name"].capability_name(input)\`, \`await kody.mcp["server-name"].tool_name(input)\`, and \`await kody.openapi["name"].operation_slug(input)\` — never a flat \`kody.kind_instance_capability(...)\` call.
- Storage, one rule per context: ad hoc execute code uses \`import { storage } from 'kody:runtime'\` against the \`storageId\` bound to the call; saved-package code always uses \`packageStorage()\` from 'kody:runtime' for the package's own data; another package's data goes through \`packages.invokeChecked\`.
- \`storage\` exposes \`get\`/\`set\`/\`list\`/\`delete\`/\`clear\` and \`storage.sql(query, params?)\`, which returns \`{ columns, rows, rowCount, rowsRead, rowsWritten }\`; read query rows from \`.rows\`. It is \`undefined\` when the call binds no \`storageId\`.
- \`packageStorage()\` returns the same storage interface bound to the declaring package's own bucket, in the package's own runtime and when the module is statically imported (\`kody:@scope/package/export\`) into an execute call or another package — no \`storageId\` needed. Inline execute code has no package provenance, so \`packageStorage()\` throws there.
- \`import { refreshAccessToken, createAuthenticatedFetch, oauthClientCredentials, secretHeaders } from 'kody:runtime'\` for OAuth integrations and secret-derived auth headers. Integration \`name\` may be account-specific (e.g. \`google-personal\`, \`google-business\`); call \`integration_list\` first when a provider may have multiple accounts connected. For client-credentials Basic Auth, save the id and secret separately and use \`secretHeaders.basic({ usernameSecret, passwordSecret, scope })\` in the Authorization header, or \`oauthClientCredentials(...)\` for the token request; do not ask users to precompute a derived Basic header.
- \`import { workflows } from 'kody:runtime'\` for durable Cloudflare Workflows. \`workflows.create\` accepts either inline \`code\` or a saved-package \`exportName\`; use \`workflow_run_list\` to inspect recent runs.
- Execute has a hard timeout (~90s by default). For batch sweeps, migrations, polling loops, or work likely to run >~60s, submit one durable \`workflows.create({ code, params })\` from a single execute call instead of chaining many MCP round-trips.
- Optional \`params\` are passed as the first argument to the module default export. Prefer \`export default async function main(input = {}) { ... }\`; pass \`input\` to shared helpers explicitly.
- \`import { packageContext } from 'kody:runtime'\` in saved package code when you need package metadata; it is \`null\` for ad hoc execute calls.
- \`import { packages } from 'kody:runtime'\` exposes \`packages.check(...)\`, \`packages.invoke(...)\`, and \`packages.invokeChecked(...)\` in saved package runtime contexts and authenticated ad hoc execute calls. Prefer \`invokeChecked\` for dynamic current-version package calls. Static cross-package imports such as \`kody:@scope/my-package/export-name\` bundle a published snapshot.
- \`fetch(...)\` is the host-provided network global; \`{{secret:name}}\` / \`{{secret:name|scope=user}}\` work in URL, headers, or body on approved hosts only. \`secretHeaders.basic(...)\` returns an opaque placeholder for fetch headers; the gateway resolves both referenced secrets, enforces host approval for both, and sends only the derived Basic header. For host approval failures, use the error’s approval path.
- Fields marked \`x-kody-secret: true\` accept the same placeholder form; respect per-secret allowed-capability lists.
- Placeholders are not general string interpolation (they do not resolve in arbitrary return values). Never place placeholder text into user-visible or third-party-visible content such as issue bodies, comments, prompts, logs, or returned strings; obfuscate the \`{{secret:...}}\` token if you must describe it literally.
- \`await kody.secret_list({ scope? })\` — metadata only. \`secret_set\` — persist values already in trusted execution (e.g. refreshed tokens); write-only. No \`secret_get\` / \`secrets\` helpers in the sandbox.
- \`value_get\` / \`value_list\` for non-secret persisted config.

Prefer one \`execute\` when the workflow is clear; split calls when you need new user input or a changed plan.

Example:

\`import { kody } from 'kody:runtime'

export default async function main(input = {}) {
  void input;
  return await kody.coding_guide_get({
    guide: 'integration_bootstrap',
  });
}\`

To return non-text MCP content blocks (e.g. images), see: https://github.com/kentcdodds/kody/blob/main/docs/use/raw-content-blocks.md

More context: https://github.com/kentcdodds/kody/blob/main/docs/use/execute.md
	`.trim(),
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
			const { baseUrl, hasUser, storageContext } =
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
