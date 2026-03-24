import {
	RESOURCE_MIME_TYPE,
	registerAppResource,
} from '@modelcontextprotocol/ext-apps/server'
import { createUIResource } from '@mcp-ui/server'
import {
	generatedUiShellResourceUri,
	renderGeneratedUiShellEntryPoint,
} from '#mcp/apps/generated-ui-shell-entry-point.ts'
import { type MCP } from '#mcp/index.ts'

const generatedUiAppResource = {
	name: 'generated_ui_app_resource',
	title: 'Generated UI App Resource',
	description:
		'Generic MCP App shell for rendering generated UI artifacts in MCP App compatible hosts.',
} as const

export async function registerGeneratedUiAppResource(agent: MCP) {
	const baseUrl = agent.requireDomain()
	const resourceDomain = new URL('/styles.css', baseUrl).origin

	registerAppResource(
		agent.server,
		generatedUiAppResource.name,
		generatedUiShellResourceUri,
		{
			title: generatedUiAppResource.title,
			description: generatedUiAppResource.description,
		},
		async () => {
			const uiResource = createUIResource({
				uri: generatedUiShellResourceUri,
				content: {
					type: 'rawHtml',
					htmlString: renderGeneratedUiShellEntryPoint(baseUrl),
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
								domain: resourceDomain,
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
