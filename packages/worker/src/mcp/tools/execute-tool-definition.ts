import { type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'

import { executeToolDescription } from '#mcp/instructions/execute-tool-description.ts'

export const executeTool = {
	name: 'execute',
	title: 'Run a Sandboxed Module',
	description: executeToolDescription,
	annotations: {
		readOnlyHint: false,
		// Execute can delete, overwrite, send, revoke, or otherwise make
		// irreversible changes depending on the module and capabilities called.
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	} satisfies ToolAnnotations,
} as const
