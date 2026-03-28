import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { generatedUiRuntimeResourceUri } from '#mcp/apps/generated-ui-runtime-html-entry.ts'
import { createGeneratedUiAppSession } from '#mcp/generated-ui-app-session.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import {
	applyUiArtifactParameters,
	parseUiArtifactParameters,
} from '#mcp/ui-artifact-parameters.ts'
import { getUiArtifactById } from '#mcp/ui-artifacts-repo.ts'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'

const openGeneratedUiTool = {
	name: 'open_generated_ui',
	title: 'Open Generated UI',
	description: `
Open the generic MCP App runtime for a generated UI.

Behavior:
- Accepts exactly one of \`code\` or \`app_id\`.
- Use \`code\` to render a new UI artifact immediately without saving it first.
- Use \`app_id\` to reopen previously saved UI source without sending that source code back through the model.
- Saved apps can declare reusable parameters; pass runtime values via \`params\` and read them from \`kodyWidget.params\` after importing \`kodyWidget\` or awaiting \`whenKodyWidgetReady()\` from \`/mcp-apps/generated-ui-runtime.js\`.
- \`code\` may be a full HTML document or a fragment.

Generated UI basics:
- The runtime exposes module helpers from \`/mcp-apps/generated-ui-runtime.js\`; prefer \`import { kodyWidget, whenKodyWidgetReady } from '/mcp-apps/generated-ui-runtime.js'\` instead of reaching through \`window\`.
- Use generated UI whenever the user needs to enter sensitive values. Do not ask the user to paste credentials into chat.
- If generated UI code hits a recoverable runtime problem, show it in the UI and also call \`sendMessage(...)\` with the next action.
- For browser-based OAuth flows, call the \`generated_ui_oauth_guide\` capability first and follow that guide for callback URLs, registration values, \`getValue(...)\`, token exchange, and host approval handling.

Use this tool when:
- You have already generated the UI source and want to render it.
- You found a saved app via \`search\` and want to reopen it by id.

Next:
- Use \`ui_save_app\` to persist a reusable UI artifact.
- Use \`ui_get_app\` when you need to inspect a saved artifact's metadata or source.
- Use \`ui_list_apps\` or \`search\` to discover saved apps.
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
			.describe('Inline UI source to render immediately.'),
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
			const appId = args.app_id ?? null
			const title = args.title ?? null
			const description = args.description ?? null
			let resolvedParams: Record<string, unknown> | undefined
			if (appId) {
				if (!callerContext.user) {
					throw new Error(
						'Authentication required to access saved UI artifacts.',
					)
				}
				const app = await getUiArtifactById(
					agent.getEnv().APP_DB,
					callerContext.user.userId,
					appId,
				)
				if (!app) {
					throw new Error('Saved UI artifact not found for this user.')
				}
				resolvedParams = applyUiArtifactParameters({
					definitions: parseUiArtifactParameters(app.parameters),
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
			}
			return {
				content: [
					{
						type: 'text',
						text: appId
							? `## Generated UI ready\n\nThe generic app runtime is attached to this tool call and will load saved app \`${appId}\` inside the widget runtime.\n\nIf the host does not display the attached UI correctly, open the hosted fallback URL: ${hostedUrl}`
							: '## Generated UI ready\n\nThe generic app runtime is attached to this tool call and will render the provided inline source inside the widget runtime.',
					},
				],
				structuredContent,
			}
		},
	)
}
