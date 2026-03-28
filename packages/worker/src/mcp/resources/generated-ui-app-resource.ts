import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
} from '@modelcontextprotocol/ext-apps/server'
import { createUIResource } from '@mcp-ui/server'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { getEnv } from '#app/env.ts'
import { computeClaudeWidgetDomain } from '#mcp/apps/claude-widget-domain.ts'
import {
	generatedUiRuntimeResourceUri,
	renderGeneratedUiRuntimeHtmlEntry,
} from '#mcp/apps/generated-ui-runtime-html-entry.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import { mcpResourcePath } from '../../mcp-auth.ts'

const generatedUiAppResource = {
	name: 'generated_ui_app_resource',
	title: 'Generated UI App Resource',
	description:
		'Generic MCP App runtime entry for rendering generated UI artifacts in MCP App compatible hosts.',
} as const

export async function registerGeneratedUiAppResource(
	agent: McpRegistrationAgent,
) {
	const requestBaseUrl = agent.requireDomain()
	const appEnv = getEnv(agent.getEnv())
	const appBaseUrl = getAppBaseUrl({
		env: appEnv,
		requestUrl: requestBaseUrl,
	})
	const resourceDomain = new URL('/styles.css', appBaseUrl).origin
	const mcpServerUrl = new URL(mcpResourcePath, appBaseUrl).toString()

	registerAppResource(
		agent.server,
		generatedUiAppResource.name,
		generatedUiRuntimeResourceUri,
		{
			title: generatedUiAppResource.title,
			description: generatedUiAppResource.description,
		},
		async () => {
			const claudeWidgetDomain = await computeClaudeWidgetDomain(mcpServerUrl)
			const uiResource = createUIResource({
				uri: generatedUiRuntimeResourceUri,
				content: {
					type: 'rawHtml',
					htmlString: renderGeneratedUiRuntimeHtmlEntry(appBaseUrl),
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
									connectDomains: [appBaseUrl],
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
