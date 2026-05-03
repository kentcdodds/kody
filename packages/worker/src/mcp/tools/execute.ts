import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	extractRawContent,
	formatExecutionOutput,
	getExecutionErrorDetails,
} from '#mcp/executor.ts'
import { runModuleWithRegistry } from '#mcp/run-codemode-registry.ts'
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

const executeTool = {
	name: 'execute',
	title: 'Execute Capabilities',
	description: `
Run one ephemeral ESM module string with a default export. Discover capability
names with \`search\`; for one capability’s \`inputSchema\` / \`outputSchema\`,
call \`search\` with \`entity: "{name}:capability"\` or use
\`meta_list_capabilities\`.

Saved package surface:
- \`package_save\`, \`package_get\`, \`package_list\`, \`package_delete\`
- repo-backed package editing with \`package_shell_open\` and
  \`package_shell_exec\`; validate and publish with \`package_check\` and
  \`package_publish\`
- cross-package imports with specifiers such as
   \`kody:@scope/my-package/export-name\`

Sandbox surface:
- Import runtime helpers from \`kody:runtime\`.
- \`import { codemode } from 'kody:runtime'\` for builtin capabilities.
- \`import { storage } from 'kody:runtime'\` for durable storage helpers on the bound \`storageId\`, including \`storage.sql(query, params?)\`.
- \`import { refreshAccessToken, createAuthenticatedFetch } from 'kody:runtime'\` for OAuth connectors.
- \`import { agentChatTurnStream } from 'kody:runtime'\` for streamed agent turns.
- \`params\` is passed to the module default export; if a shared helper needs it, \`import { params } from 'kody:runtime'\`.
- \`import { packageContext } from 'kody:runtime'\` in saved package code when you need package metadata; it is \`null\` for ad hoc execute calls.
- \`fetch(...)\` is the host-provided network global; \`{{secret:name}}\` / \`{{secret:name|scope=user}}\` work in URL, headers, or body on approved hosts only.
- Fields marked \`x-kody-secret: true\` accept the same placeholder form; respect per-secret allowed-capability lists.
- Placeholders are not general string interpolation (they do not resolve in arbitrary return values).
- Never place placeholder text into user-visible or third-party-visible content such as issue bodies, comments, prompts, logs, or returned strings. If you need to describe a placeholder literally, obfuscate it instead of embedding the exact \`{{secret:...}}\` token into content that may be sent over \`fetch\`.
- \`await codemode.secret_list({ scope? })\` — metadata only. \`secret_set\` — persist values already in trusted execution (e.g. refreshed tokens); write-only.
- No \`secret_get\` / \`secrets\` helpers in the sandbox.
- \`value_get\` / \`value_list\` for non-secret persisted config.

Never ask the user to paste credentials in chat; use generated UI to collect or rotate secrets. If a host is not approved, use the error’s approval path instead of blind retries.

Prefer one \`execute\` when the workflow is clear; split calls when you need new user input or a changed plan.

Example:

\`import { codemode } from 'kody:runtime'

export default async function run() {
  return await codemode.kody_official_guide({
    guide: 'integration_bootstrap',
  });
}\`

To return non-text MCP content blocks (e.g. images), see: https://github.com/kentcdodds/kody/blob/main/docs/use/raw-content-blocks.md

More context: https://github.com/kentcdodds/kody/blob/main/docs/use/execute.md
	`.trim(),
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
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
						'Single ESM module string with imports/exports and a default export to execute.',
					),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						'Optional JSON params passed to the module default export at execution time.',
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
			conversationId,
			memoryContext,
		}: {
			code: string
			params?: Record<string, unknown>
			storageId?: string
			writable?: boolean
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
			const result = await Sentry.startSpan(
				{
					name: 'mcp.tool.execute',
					op: 'mcp.tool',
					attributes: {
						'mcp.tool': 'execute',
					},
				},
				async () =>
					runModuleWithRegistry(env, callerContext, code, params, {
						executorExports: agent.getLoopbackExports(),
						storageTools: activeStorageId
							? {
									userId: callerContext.user?.userId ?? '',
									storageId: activeStorageId,
									writable: writable ?? false,
								}
							: undefined,
					}),
			)
			const timing = finishToolTiming(timingStart)
			const durationMs = timing.durationMs

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
						...formatSurfacedMemoriesMarkdown(surfacedMemories),
					]),
					structuredContent: {
						conversationId: resolvedConversationId,
						timing,
						...(activeStorageId ? { storage: { id: activeStorageId } } : {}),
						error: errorMessage,
						errorDetails,
						logs: result.logs ?? [],
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
			const rawContent = extractRawContent(result.result)
			return {
				content: prependToolMetadataContent(resolvedConversationId, [
					...(rawContent ?? [
						{
							type: 'text',
							text: formatExecutionOutput(result),
						},
					]),
					...formatSurfacedMemoriesMarkdown(surfacedMemories),
				]),
				structuredContent: {
					conversationId: resolvedConversationId,
					timing,
					...(activeStorageId ? { storage: { id: activeStorageId } } : {}),
					result: rawContent ? null : result.result,
					logs: result.logs ?? [],
					...buildMemoryStructuredContent(surfacedMemories),
				},
				isError: false,
			}
		},
	)
}
