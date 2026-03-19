import { type McpCallerContext } from '#shared/chat.ts'

export type McpToolKind = 'search' | 'execute' | 'capability'

export type McpFailurePhase = 'parse_input' | 'handler' | 'parse_output'

export type McpObservabilityPayload = {
	category: 'mcp'
	tool: McpToolKind
	toolName?: string
	capabilityName?: string
	domain?: string
	outcome: 'success' | 'failure'
	durationMs: number
	baseUrl: string
	hasUser: boolean
	failurePhase?: McpFailurePhase
	sandboxError?: boolean
	registeredCapabilityCount?: number
	errorName?: string
	errorMessage?: string
	timestamp: string
}

export function callerContextFields(context: McpCallerContext) {
	return {
		baseUrl: context.baseUrl,
		hasUser: context.user != null,
	}
}

export function errorFields(error: unknown): {
	errorName: string
	errorMessage: string
} {
	if (error instanceof Error) {
		return { errorName: error.name, errorMessage: error.message }
	}
	return { errorName: 'Unknown', errorMessage: String(error) }
}

export function logMcpEvent(
	event: Omit<McpObservabilityPayload, 'timestamp'> & { timestamp?: string },
) {
	try {
		const payload: McpObservabilityPayload = {
			...event,
			timestamp: event.timestamp ?? new Date().toISOString(),
		}
		console.info('mcp-event', JSON.stringify(payload))
	} catch (error) {
		console.warn('mcp-event-failed', error)
	}
}
