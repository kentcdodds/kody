import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { generatedUiShellResourceUri } from '#mcp/apps/generated-ui-shell-entry-point.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import { buildSavedUiUrl } from '#worker/ui-artifact-urls.ts'
import {
	createGeneratedUiAppSession,
	type GeneratedUiAppSessionEnvelope,
} from '#mcp/generated-ui-app-session.ts'

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
- \`executeCode(code)\` sends a server request through the generated UI shell. It is not local eval in the widget. When route context is available, the shell calls \`POST /ui-api/:uiId/execute\`.
- \`invokeAction({ code, params })\` also uses the generated UI execute endpoint and is the preferred helper when you want to pass structured input into server-side code.
- \`submitSecureInput({ setupId, fields })\` sends sensitive fields like PATs or client secrets to \`POST /ui-api/:uiId/secure-input\` so those values do not need to pass through model-visible tool arguments.
- The same generated UI code should work both in hosted Kody pages and in MCP app hosts. The server handles the auth difference behind the same \`/ui-api/:uiId/*\` contract.
- Calling \`executeCode(code)\` on init is allowed when it is intentional, for example to hydrate UI state on first render. Prefer explicit user actions when the work should be user-driven.

Mini standard library:
\`\`\`ts
declare global {
  interface Window {
    kodyWidget: {
      sendMessage(text: string): boolean
      openLink(url: string): boolean
      toggleFullscreen(): Promise<'inline' | 'fullscreen' | 'pip' | null>
      invokeAction(input: { code: string; params?: Record<string, unknown> }): Promise<{ ok: boolean; result?: unknown; error?: string; logs?: Array<string> }>
      submitSecureInput(input: { setupId: string; fields: Record<string, string> }): Promise<{ ok: boolean; stored_secret_names?: Array<string>; missing_secret_names?: Array<string>; status?: string }>
      // Server-side execution helper.
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
    const result = await window.kodyWidget.invokeAction({
      code: \`async (params) => { ... }\`,
      params: { ...Object.fromEntries(new FormData(event.currentTarget)) },
    })
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
			const callerContext = agent.getCallerContext()
			const appSession =
				callerContext.user != null
					? await createGeneratedUiAppSession(
							agent.getEnv(),
							callerContext.baseUrl,
							callerContext.user,
						)
					: null
			const appSessionEnvelope: GeneratedUiAppSessionEnvelope | null =
				appSession
					? {
							sessionId: appSession.sessionId,
							token: appSession.token,
							expiresAt: appSession.expiresAt,
							endpoints: appSession.endpoints,
						}
					: null
			const appId = args.app_id ?? null
			const title = args.title ?? null
			const description = args.description ?? null
			const hostedUrl = appId
				? buildSavedUiUrl(agent.requireDomain(), appId)
				: null
			const structuredContent = {
				widget: 'generated_ui' as const,
				resourceUri: generatedUiShellResourceUri,
				renderSource: appId ? ('saved_app' as const) : ('inline_code' as const),
				appId,
				title,
				description,
				runtime: 'html' as const,
				sourceCode: args.code ?? null,
				hostedUrl,
				appSession: appSessionEnvelope,
			}
			return {
				content: [
					{
						type: 'text',
						text: appId
							? `## Generated UI ready\n\nThe generic app shell is attached to this tool call and will load saved app \`${appId}\` inside the widget runtime.\n\nIf the host does not display the attached UI correctly, open the hosted fallback URL: ${hostedUrl}\n\nNote: tool calls do not work in the hosted fallback.`
							: '## Generated UI ready\n\nThe generic app shell is attached to this tool call and will render the provided inline source inside the widget runtime.',
					},
				],
				structuredContent,
			}
		},
	)
}
