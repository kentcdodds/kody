import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
} from '@modelcontextprotocol/ext-apps/server'
import { createUIResource } from '@mcp-ui/server'
import { computeClaudeWidgetDomain } from '#mcp/apps/claude-widget-domain.ts'
import {
	generatedUiShellResourceUri,
	renderGeneratedUiShellEntryPoint,
} from '#mcp/apps/generated-ui-shell-entry-point.ts'
import { type MCP } from '#mcp/index.ts'
import { mcpResourcePath } from '../../mcp-auth.ts'

const generatedUiAppResource = {
	name: 'generated_ui_app_resource',
	title: 'Generated UI App Resource',
	description:
		'Generic MCP App shell for rendering generated UI artifacts in MCP App compatible hosts.',
} as const

export async function registerGeneratedUiAppResource(agent: MCP) {
	const requestBaseUrl = agent.requireDomain()
	const envBinding = agent.getEnv()
	const configuredBase =
		typeof envBinding.APP_BASE_URL === 'string' &&
		envBinding.APP_BASE_URL.trim() !== ''
			? envBinding.APP_BASE_URL.trim()
			: undefined
	const appBaseUrl = configuredBase ?? requestBaseUrl
	const resourceDomain = new URL('/styles.css', appBaseUrl).origin
	const mcpServerUrl = new URL(mcpResourcePath, appBaseUrl).toString()

	registerAppResource(
		agent.server,
		generatedUiAppResource.name,
		generatedUiShellResourceUri,
		{
			title: generatedUiAppResource.title,
			description: generatedUiAppResource.description,
		},
		async () => {
			const claudeWidgetDomain = await computeClaudeWidgetDomain(mcpServerUrl)
			const uiResource = createUIResource({
				uri: generatedUiShellResourceUri,
				content: {
					type: 'rawHtml',
					htmlString: renderGeneratedUiShellEntryPoint(appBaseUrl),
				},
				encoding: 'text',
				adapters: {
					mcpApps: {
						enabled: true,
					},
				},
			})

			return {
				contents: [
					{
						...uiResource.resource,
						mimeType: RESOURCE_MIME_TYPE,
						_meta: {
							ui: {
								prefersBorder: true,
								domain: claudeWidgetDomain,
								csp: {
									resourceDomains: [resourceDomain],
								},
							},
							'openai/widgetDomain': resourceDomain,
						},
					},
				],
			}
		},
	)
}
