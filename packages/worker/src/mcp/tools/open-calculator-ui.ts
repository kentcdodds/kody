import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { calculatorUiResourceUri } from '#mcp/apps/calculator-ui-entry-point.ts'
import { type MCP } from '#mcp/index.ts'

const openCalculatorUiTool = {
	name: 'open_calculator_ui',
	title: 'Open Calculator UI',
	description: `
Show an interactive calculator MCP App widget.

Behavior:
- Opens a calculator app resource that runs arithmetic directly in the UI.
- Supports mouse and keyboard input.

Next:
- Use 'do_math' when you need a precise, machine-readable result in tool output.
	`.trim(),
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} satisfies ToolAnnotations,
} as const

export async function registerOpenCalculatorUiTool(agent: MCP) {
	registerAppTool(
		agent.server,
		openCalculatorUiTool.name,
		{
			title: openCalculatorUiTool.title,
			description: openCalculatorUiTool.description,
			annotations: openCalculatorUiTool.annotations,
			_meta: {
				ui: {
					resourceUri: calculatorUiResourceUri,
				},
			},
		},
		async () => {
			return {
				content: [
					{
						type: 'text',
						text: `
## Calculator widget ready

The calculator UI is attached to this tool call.

- Use number keys, operators, Enter, and Backspace.
- Use **AC** (or keyboard **c**) to reset all state.
						`.trim(),
					},
				],
				structuredContent: {
					widget: 'calculator',
					resourceUri: calculatorUiResourceUri,
				},
			}
		},
	)
}
