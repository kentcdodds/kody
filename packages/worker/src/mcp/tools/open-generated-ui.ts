import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { generatedUiShellResourceUri } from '#mcp/apps/generated-ui-shell-entry-point.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'

const openGeneratedUiTool = {
	name: 'open_generated_ui',
	title: 'Open Generated UI',
	description: `
Open the generic MCP App shell for a generated UI.

Behavior:
- Accepts exactly one of \`code\` or \`app_id\`.
- Use \`code\` to render a new UI artifact immediately without saving it first.
- Use \`app_id\` to reopen previously saved UI source without sending that source code back through the model.
- \`code\` may be a full HTML document or a fragment. Prefer body content when possible, but full-document HTML is supported when you need total control.
- The shell provides a tiny standard library on \`window.kodyWidget\` plus lightweight default styles for semantic HTML, forms, tables, buttons, and code blocks.
- \`executeCode(code)\` posts a request back to the host, and the host handles it by calling the Kody MCP server tool \`execute\` with that same code string.

Mini standard library:
\`\`\`ts
declare global {
  interface Window {
    kodyWidget: {
      sendMessage(text: string): boolean
      openLink(url: string): boolean
      toggleFullscreen(): Promise<'inline' | 'fullscreen' | 'pip' | null>
      // Equivalent to calling MCP tool \`execute\` with { code }.
      executeCode(code: string): Promise<unknown>
    }
  }
}
\`\`\`

Theme tokens:
- \`--color-bg\`, \`--color-surface\`, \`--color-fg\`, \`--color-muted\`
- \`--color-border\`, \`--color-accent\`, \`--color-accent-contrast\`
- \`--font-body\`, \`--font-mono\`
- \`--spacing-2\`, \`--spacing-3\`, \`--spacing-4\`, \`--spacing-6\`
- \`--radius-2\`, \`--radius-3\`, \`--shadow-1\`

Example:
\`\`\`html
<form>
  ...
</form>
<script>
  document.querySelector('form')?.addEventListener('submit', async (event) => {
    event.preventDefault()
    const result = await window.kodyWidget.executeCode(\`async () => { ... }\`)
    window.kodyWidget.sendMessage(\`Done: ...\`)
    ...
  })
</script>
\`\`\`

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
	})
	.refine((value) => (value.code ? 1 : 0) + (value.app_id ? 1 : 0) === 1, {
		message: 'Provide exactly one of `code` or `app_id`.',
		path: ['code'],
	})

export async function registerOpenGeneratedUiTool(agent: McpRegistrationAgent) {
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
				runtime: 'html' as const,
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
