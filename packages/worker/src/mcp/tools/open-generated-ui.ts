import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { generatedUiShellResourceUri } from '#mcp/apps/generated-ui-shell-entry-point.ts'
import { type MCP } from '#mcp/index.ts'

const openGeneratedUiTool = {
	name: 'open_generated_ui',
	title: 'Open Generated UI',
	description: `
Open the generic MCP App shell for a generated UI.

Behavior:
- Accepts exactly one of \`code\` or \`app_id\`.
- Use \`code\` to render a new UI artifact immediately without saving it first.
- Use \`app_id\` to reopen previously saved UI source without sending that source code back through the model.
- The shell supports host render data, opening external links, requesting fullscreen when supported by the host, sending follow-up messages, and calling app-only tools on the same MCP server.

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
			.describe(
				'Inline UI source for an ephemeral render. Provide this for a fresh generated UI that does not need to be saved first.',
			),
		app_id: z
			.string()
			.min(1)
			.optional()
			.describe(
				'Saved UI artifact id to reopen without sending the stored source code back through the model.',
			),
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
	})
	.refine((value) => (value.code ? 1 : 0) + (value.app_id ? 1 : 0) === 1, {
		message: 'Provide exactly one of `code` or `app_id`.',
		path: ['code'],
	})

export async function registerOpenGeneratedUiTool(agent: MCP) {
	void agent
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
					resourceUri: generatedUiShellResourceUri,
				},
			},
		},
		async (args) => {
			const appId = args.app_id ?? null
			const title = args.title ?? null
			const description = args.description ?? null
			const structuredContent = {
				widget: 'generated_ui' as const,
				resourceUri: generatedUiShellResourceUri,
				renderSource: appId ? ('saved_app' as const) : ('inline_code' as const),
				appId,
				title,
				description,
				sourceCode: args.code ?? null,
			}
			return {
				content: [
					{
						type: 'text',
						text: appId
							? `## Generated UI ready\n\nThe generic app shell is attached to this tool call and will load saved app \`${appId}\` inside the widget runtime.`
							: '## Generated UI ready\n\nThe generic app shell is attached to this tool call and will render the provided inline source inside the widget runtime.',
					},
				],
				structuredContent,
			}
		},
	)
}
