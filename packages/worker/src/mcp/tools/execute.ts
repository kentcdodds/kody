import * as Sentry from '@sentry/cloudflare'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { z } from 'zod'
import {
	defaultExecutionResponseLimitBytes,
	extractRawContent,
	formatLimitedExecutionOutput,
	limitExecutionResultValue,
	formatExecutionOutput,
	getExecutionErrorDetails,
} from '#mcp/executor.ts'
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
import { repoRunCommandsExecuteSummary } from '#mcp/capabilities/repo/repo-run-commands-text.ts'
import { finishToolTiming, startToolTiming } from './tool-timing.ts'
import { prependToolMetadataContent } from './tool-response-content.ts'

const executeTool = {
	name: 'execute',
	title: 'Execute Capabilities',
	description: `
Run one ephemeral ESM module string with a default export. Imports may be arbitrary npm packages compatible with the Cloudflare Workers runtime (e.g. \`p-retry\`, \`mailparser\`, \`remark\`); prefer existing packages over rewriting helpers. Discover capability names with \`search\`; for one capability’s executable snippet and TypeScript call shape, call \`search\` with \`entity: "{name}:capability"\` or use \`meta_list_capabilities\`.

Projection rule: you write the code -- if a call returns a large response, project the fields you need before returning. Never return raw API responses; extract a slim shape (e.g. \`{ id, subject, snippet }\`) or a summary.

Saved package surface:
- \`package_save\`, \`package_get\`, \`package_list\`, \`package_delete\`
- repo-backed package editing with \`repo_run_commands\`; ${repoRunCommandsExecuteSummary}
- cross-package imports with specifiers such as
   \`kody:@scope/my-package/export-name\`
- When creating or materially changing a package, load \`coding_guide_get({ guide: 'package_authoring' })\` and keep a root \`README.md\` \`## Intent\` section with the user-defined goal.

Sandbox surface:
- Import runtime helpers from \`kody:runtime\`.
- \`import { kody } from 'kody:runtime'\` for builtin capabilities discovered by \`search\`; call valid identifier names as \`await kody.capability_id(input)\`. If a capability id is not a valid JavaScript identifier, use bracket notation: \`await kody["capability-id"](input)\`. Capability detail from \`search({ entity: "{name}:capability" })\` includes the exact snippet.
- \`import { storage } from 'kody:runtime'\` for durable storage helpers on the bound \`storageId\`, including \`storage.sql(query, params?)\`. \`storage.sql\` returns \`{ columns, rows, rowCount, rowsRead, rowsWritten }\`; read query rows from \`.rows\`.
- \`import { refreshAccessToken, createAuthenticatedFetch, oauthClientCredentials, secretHeaders } from 'kody:runtime'\` for OAuth integrations and secret-derived auth headers. Integration \`name\` may be account-specific (e.g. \`google-personal\`, \`google-business\`); call \`integration_list\` first when the task involves a provider that may have multiple accounts connected. For APIs such as PayPal that require client-credentials Basic Auth, save the client id and client secret separately and use \`secretHeaders.basic({ usernameSecret: 'paypalClientId', passwordSecret: 'paypalClientSecret', scope: 'user' })\` in the Authorization header, or \`oauthClientCredentials(...)\` for the token request. Do not ask users to precompute or save a derived Basic header.
- \`import { workflows } from 'kody:runtime'\` for durable Cloudflare Workflows. \`workflows.create\` accepts either inline \`code\` or a saved-package \`exportName\`; use \`workflow_run_list\` to inspect recent runs.
- Execute has a hard timeout (~90s by default). For batch sweeps, migrations, polling loops, or work likely to run >~60s, submit one durable \`workflows.create({ code, params })\` from a single execute call instead of chaining many MCP round-trips.
- Optional \`params\` are passed as the first argument to the module default export. Prefer \`export default async function main(input = {}) { ... }\`; pass \`input\` to shared helpers explicitly.
- \`import { packageContext } from 'kody:runtime'\` in saved package code when you need package metadata; it is \`null\` for ad hoc execute calls.
- \`import { packages } from 'kody:runtime'\` exposes \`packages.check(...)\`, \`packages.invoke(...)\`, and \`packages.invokeChecked(...)\` in saved package runtime contexts and authenticated ad hoc execute calls. Prefer \`invokeChecked\` for dynamic current-version package calls unless you already called \`check\` and pass \`check.invoke\` to \`invoke\`.
- \`fetch(...)\` is the host-provided network global; \`{{secret:name}}\` / \`{{secret:name|scope=user}}\` work in URL, headers, or body on approved hosts only. \`secretHeaders.basic(...)\` returns an opaque placeholder for fetch headers; the gateway resolves both referenced secrets, enforces host approval for both, and sends only the derived Basic header.
- Fields marked \`x-kody-secret: true\` accept the same placeholder form; respect per-secret allowed-capability lists.
- Placeholders are not general string interpolation (they do not resolve in arbitrary return values).
- Never place placeholder text into user-visible or third-party-visible content such as issue bodies, comments, prompts, logs, or returned strings. If you need to describe a placeholder literally, obfuscate it instead of embedding the exact \`{{secret:...}}\` token into content that may be sent over \`fetch\`.
- \`await kody.secret_list({ scope? })\` — metadata only. \`secret_set\` — persist values already in trusted execution (e.g. refreshed tokens); write-only.
- No \`secret_get\` / \`secrets\` helpers in the sandbox.
- \`value_get\` / \`value_list\` for non-secret persisted config.

Credential collection and rotation use standard Kody setup pages: \`/connect/oauth\` for OAuth integrations and \`/account/secrets/new\` for API keys, PATs, and other user-provided secrets. Never ask users to paste secrets, tokens, API keys, passwords, or credentials into chat. For host approval failures, use the error’s approval path.

Prefer one \`execute\` when the workflow is clear; split calls when you need new user input or a changed plan.

For integration-backed packages, package apps, or workflows, use \`search\` and \`coding_guide_get({ guide: 'integration_bootstrap' })\` before building. Confirm the needed \`integration\` or \`secret\` entity exists, then run a cheap read-only authenticated smoke test in \`execute\` (for example a profile/viewer endpoint) before \`package_save\`, package app work, or workflow scheduling. If credentials are missing, load the matching official guide: \`oauth\`, \`connect_secret\`, or \`secret_backed_integration\`.

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
						`Soft cap on the size of the value returned from your default export. Defaults to ~100 KB. Returns over the cap are truncated and the response includes a note. You write the code -- if you only need a few fields, project before returning. Examples:
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
							returnedBytes: 0,
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
				const limitedResult = limitExecutionResultValue(
					result.result,
					responseLimit ?? defaultExecutionResponseLimitBytes,
				)
				const rawContent = limitedResult.truncated
					? null
					: extractRawContent(limitedResult.value)
				return {
					content: prependToolMetadataContent(resolvedConversationId, [
						...(rawContent ?? [
							{
								type: 'text',
								text: formatLimitedExecutionOutput({
									value: limitedResult.value,
									truncated: limitedResult.truncated,
									note: limitedResult.note,
									displayText: limitedResult.displayText,
								}),
							},
						]),
						...formatSurfacedMemoriesMarkdown(surfacedMemories),
					]),
					structuredContent: {
						conversationId: resolvedConversationId,
						timing,
						...(activeStorageId ? { storage: { id: activeStorageId } } : {}),
						returnedBytes: limitedResult.returnedBytes,
						...(limitedResult.truncated
							? {
									truncated: true,
									note: limitedResult.note,
								}
							: {}),
						result: rawContent ? null : limitedResult.value,
						logs: result.logs ?? [],
						...buildMemoryStructuredContent(surfacedMemories),
					},
					isError: false,
				}
			}
		},
	)
}
