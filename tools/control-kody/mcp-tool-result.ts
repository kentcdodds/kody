import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'

const mcpCallTimeoutMs = 180_000

export type McpCallToolOptions = {
	timeout?: number
	resetTimeoutOnProgress?: boolean
	maxTotalTimeout?: number
}

export type McpCallTool = (
	params: {
		name: string
		arguments: Record<string, unknown>
	},
	options?: McpCallToolOptions,
) => Promise<unknown>

export type McpCallConnection = {
	cookieHeader: string
	client: { callTool: McpCallTool }
	[Symbol.asyncDispose]?: () => Promise<void> | void
}

export const defaultMcpCallOptions = {
	timeout: mcpCallTimeoutMs,
	resetTimeoutOnProgress: true,
	maxTotalTimeout: mcpCallTimeoutMs,
} satisfies McpCallToolOptions

export function readMcpToolPayload(toolResult: unknown) {
	if (!toolResult || typeof toolResult !== 'object') {
		throw new Error('MCP tool returned no result.')
	}
	const record = toolResult as CallToolResult
	if (record.isError) {
		throw new Error(`MCP tool failed: ${mcpToolErrorText(record)}`)
	}
	if (
		record.structuredContent !== undefined &&
		record.structuredContent !== null
	) {
		return record.structuredContent
	}
	const text = mcpToolContentText(record)
	if (text) return text
	throw new Error('MCP tool returned no result.')
}

export function readExecuteResult(toolResult: unknown) {
	const payload = readMcpToolPayload(toolResult)
	if (!payload || typeof payload !== 'object') {
		throw new Error('execute returned an unexpected result.')
	}
	const structured = payload as { result?: unknown; error?: unknown }
	if (structured.error) {
		const text = mcpToolErrorText(
			toolResult as CallToolResult,
			structured.error,
		)
		throw new Error(`execute failed: ${text}`)
	}
	if (structured.result === undefined || structured.result === null) {
		throw new Error('execute returned no result.')
	}
	return structured.result
}

function mcpToolContentText(record: CallToolResult) {
	return (
		record.content
			?.filter((block) => block.type === 'text')
			.map((block) => block.text)
			.join('\n')
			.trim() ?? ''
	)
}

function mcpToolErrorText(record: CallToolResult, error?: unknown) {
	const contentText = mcpToolContentText(record)
	if (contentText) return contentText
	if (typeof error === 'string' && error.length > 0) return error
	if (error !== undefined) return JSON.stringify(error)
	return 'unknown MCP tool error'
}
