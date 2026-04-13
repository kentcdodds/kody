import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { generatedUiRuntimeResourceUri } from '#mcp/apps/generated-ui-runtime-html-entry.ts'
import {
	buildSavedAppBackendBasePath,
	createGeneratedUiAppSession,
} from '#mcp/generated-ui-app-session.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	conversationIdInputField,
	memoryContextInputField,
	resolveConversationId,
} from '#mcp/tools/tool-call-context.ts'
import {
	loadRelevantMemoriesForTool,
	formatSurfacedMemoriesMarkdown,
	buildMemoryStructuredContent,
} from '#mcp/tools/memory-tool-context.ts'
import {
	applyUiArtifactParameters,
	parseUiArtifactParameters,
} from '#mcp/ui-artifact-parameters.ts'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { hasUiArtifactServerCode } from '#mcp/ui-artifacts-types.ts'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
import {
	appendToolContent,
	prependToolMetadataContent,
} from './tool-response-content.ts'

const openGeneratedUiTool = {
	name: 'open_generated_ui',
	title: 'Open Generated UI',
	description: `
Open the MCP App runtime. Pass exactly one of \`code\` (inline HTML fragment or
full document) or \`app_id\` (reopen saved source without resending it). \`params\`
only with \`app_id\` — validated against the app’s saved parameter definitions;
read \`kodyWidget.params\` after \`import { kodyWidget } from '@kody/ui-utils'\`.

Use for sensitive input (never ask the user to paste credentials in chat).
Recoverable errors: show in the UI and \`sendMessage(...)\` with the next step.
If the app depends on a third-party integration, load \`kody_official_guide\` (\`guide: "integration_bootstrap"\`) before building or saving the downstream app.
OAuth: standard path is \`/connect/oauth\`—then run \`kody_official_guide\` (\`guide: "oauth"\`); for OAuth inside a saved app only, use \`guide: "generated_ui_oauth"\`.
Do not treat an auth-dependent app as complete until the required connector/secret exists and a minimal authenticated smoke test succeeds.

Persist with \`ui_save_app\`; discover with \`search\` or \`ui_list_apps\`.

https://github.com/kentcdodds/kody/blob/main/docs/use/skills-and-apps.md
	`.trim(),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} satisfies ToolAnnotations,
} as const

const inputSchema = z
	.object({
		code: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Inline HTML source to render immediately. Provide an HTML fragment or full HTML document.',
			),
		app_id: z
			.string()
			.min(1)
			.optional()
			.describe('Saved UI artifact id to reopen.'),
		title: z
			.string()
			.min(1)
			.optional()
			.describe('Optional display title for the current render session.'),
		description: z
			.string()
			.min(1)
			.optional()
			.describe('Optional short description for the current render session.'),
		conversationId: conversationIdInputField,
		memoryContext: memoryContextInputField,
		params: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				'Optional runtime parameter values for a saved app (validated against its saved parameter definitions).',
			),
	})
	.refine((value) => (value.code ? 1 : 0) + (value.app_id ? 1 : 0) === 1, {
		message: 'Provide exactly one of `code` or `app_id`.',
		path: ['code'],
	})
	.refine((value) => !(value.code && value.params), {
		message: '`params` is only supported with `app_id`.',
		path: ['params'],
	})

export async function registerOpenGeneratedUiTool(agent: McpRegistrationAgent) {
	registerAppTool(
		agent.server,
		openGeneratedUiTool.name,
		{
			title: openGeneratedUiTool.title,
			description: openGeneratedUiTool.description,
			inputSchema,
			annotations: openGeneratedUiTool.annotations,
			_meta: {
				ui: {
					resourceUri: generatedUiRuntimeResourceUri,
				},
			},
		},
		async (args) => {
			const callerContext = agent.getCallerContext()
			const conversationId = resolveConversationId(args.conversationId)
			const appId = args.app_id ?? null
			const title = args.title ?? null
			const description = args.description ?? null
			let resolvedParams: Record<string, unknown> | undefined
			let savedApp: Awaited<ReturnType<typeof getUiArtifactById>> | null = null
			if (appId) {
				if (!callerContext.user) {
					throw new Error(
						'Authentication required to access saved UI artifacts.',
					)
				}
				savedApp = await getUiArtifactById(
					agent.getEnv().APP_DB,
					callerContext.user.userId,
					appId,
				)
				if (!savedApp) {
					throw new Error('Saved UI artifact not found for this user.')
				}
				resolvedParams = applyUiArtifactParameters({
					definitions: parseUiArtifactParameters(savedApp.parameters),
					values: args.params,
				})
			}
			const hostedUrl = appId
				? buildSavedUiUrl(agent.requireDomain(), appId, {
						params: resolvedParams,
					})
				: null
			const appSession =
				callerContext.user != null
					? await createGeneratedUiAppSession({
							env: agent.getEnv(),
							baseUrl: callerContext.baseUrl,
							user: callerContext.user,
							appId,
							homeConnectorId: callerContext.homeConnectorId ?? null,
							params: resolvedParams,
						})
					: null
			const structuredContent = {
				conversationId,
				widget: 'generated_ui' as const,
				resourceUri: generatedUiRuntimeResourceUri,
				renderSource: appId ? ('saved_app' as const) : ('inline_code' as const),
				appId,
				title,
				description,
				runtime: 'html' as const,
				sourceCode: args.code ?? null,
				params: resolvedParams,
				hostedUrl,
				appSession,
				appBackend: hasUiArtifactServerCode(savedApp?.serverCode)
					? {
							basePath: buildSavedAppBackendBasePath(savedApp.id),
							facetNames: ['main'],
						}
					: null,
			}
			const memoryResult = await loadRelevantMemoriesForTool({
				env: agent.getEnv(),
				callerContext,
				conversationId,
				memoryContext: args.memoryContext,
			})
			return {
				content: prependToolMetadataContent(
					conversationId,
					appendToolContent(
						[
							{
								type: 'text',
								text: appId
									? `## Generated UI ready\n\nThe generic app runtime is attached to this tool call and will load saved app \`${appId}\` inside the widget runtime.\n\nIf the host does not display the attached UI correctly, open the hosted fallback URL: ${hostedUrl}`
									: '## Generated UI ready\n\nThe generic app runtime is attached to this tool call and will render the provided inline source inside the widget runtime.',
							},
						],
						formatSurfacedMemoriesMarkdown(memoryResult),
					),
				),
				structuredContent: {
					...structuredContent,
					...buildMemoryStructuredContent(memoryResult),
				},
			}
		},
	)
}
