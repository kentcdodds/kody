import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	extractRawContent,
	formatExecutionOutput,
	getExecutionErrorDetails,
} from '#mcp/executor.ts'
import { runCodemodeWithRegistry } from '#mcp/run-codemode-registry.ts'
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
import { prependToolMetadataContent } from './tool-response-content.ts'

const executeTool = {
	name: 'execute',
	title: 'Execute Capabilities',
	description: `
Run an async JavaScript arrow function against \`codemode\` (one method per
builtin capability). Discover names with \`search\`; for one capability’s
\`inputSchema\` / \`outputSchema\`, call \`search\` with
\`entity: "{name}:capability"\` or use \`meta_list_capabilities\`.

Saved skills: prefer \`meta_run_skill({ name, params })\`, or \`meta_get_skill\`
then paste code here.

Scheduled jobs: use \`scheduler_create\`, \`scheduler_list\`, \`scheduler_get\`,
\`scheduler_update\`, \`scheduler_delete\`, and \`scheduler_run_now\` to manage
one-shot or recurring codemode executions for the signed-in user.

Sandbox surface:
- \`codemode\`: \`(args) => Promise<unknown>\` per capability.
- \`refreshAccessToken(providerName)\`, \`createAuthenticatedFetch(providerName)\` for OAuth connectors.
- \`fetch(...)\` through the host gateway; \`{{secret:name}}\` / \`{{secret:name|scope=user}}\` in URL, headers, or body on approved hosts only.
- Fields marked \`x-kody-secret: true\` accept the same placeholder form; respect per-secret allowed-capability lists.
- Placeholders are not general string interpolation (they do not resolve in arbitrary return values).
- Never place placeholder text into user-visible or third-party-visible content such as issue bodies, comments, prompts, logs, or returned strings. If you need to describe a placeholder literally, obfuscate it instead of embedding the exact \`{{secret:...}}\` token into content that may be sent over \`fetch\`.
- \`await codemode.secret_list({ scope? })\` — metadata only. \`secret_set\` — persist values already in trusted execution (e.g. refreshed tokens); write-only.
- No \`secret_get\` / \`secrets\` helpers in the sandbox.
- \`value_get\` / \`value_list\` for non-secret persisted config.

Never ask the user to paste credentials in chat; use generated UI to collect or rotate secrets. If a host is not approved, use the error’s approval path instead of blind retries.

Prefer one \`execute\` when the workflow is clear; split calls when you need new user input or a changed plan.

Example:

\`async () => {
  const page = await codemode.page_to_markdown({
    url: 'https://developers.cloudflare.com/api/resources/accounts/',
  });
  return { source: page.source, preview: page.markdown.slice(0, 120) };
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
					.describe('JavaScript async arrow function to execute capabilities.'),
				params: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						'Optional JSON params injected as `params` when invoking the async function.',
					),
				conversationId: conversationIdInputField,
				memoryContext: memoryContextInputField,
			},
			annotations: executeTool.annotations,
		},
		async ({
			code,
			params,
			conversationId,
			memoryContext,
		}: {
			code: string
			params?: Record<string, unknown>
			conversationId?: string
			memoryContext?: z.infer<typeof memoryContextInputField>
		}) => {
			const startedAt = performance.now()
			const env = agent.getEnv()
			const callerContext = agent.getCallerContext()
			const resolvedConversationId = resolveConversationId(conversationId)
			const { baseUrl, hasUser } = callerContextFields(callerContext)
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
					runCodemodeWithRegistry(
						env,
						callerContext,
						code,
						params,
						agent.getLoopbackExports(),
					),
			)
			const durationMs = Math.round(performance.now() - startedAt)

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
					result: rawContent ? null : result.result,
					logs: result.logs ?? [],
					...buildMemoryStructuredContent(surfacedMemories),
				},
				isError: false,
			}
		},
	)
}
