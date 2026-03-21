import * as Sentry from '@sentry/cloudflare'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'

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

export type LogMcpEventInput = Omit<McpObservabilityPayload, 'timestamp'> & {
	timestamp?: string
	/** Original error for Sentry (not serialized on the log line). */
	cause?: unknown
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

function reportMcpFailureToSentry(
	payload: McpObservabilityPayload,
	cause?: unknown,
) {
	try {
		if (!Sentry.isInitialized()) return
		const client = Sentry.getClient()
		if (!client?.getOptions().dsn) return

		Sentry.withScope((scope) => {
			const level = payload.sandboxError ? 'warning' : 'error'
			scope.setLevel(level)

			scope.setTag('mcp.tool', payload.tool)
			if (payload.toolName) scope.setTag('mcp.tool_name', payload.toolName)
			if (payload.capabilityName) {
				scope.setTag('mcp.capability', payload.capabilityName)
			}
			if (payload.domain) scope.setTag('mcp.domain', payload.domain)
			if (payload.failurePhase) {
				scope.setTag('mcp.failure_phase', payload.failurePhase)
			}
			if (payload.sandboxError) scope.setTag('mcp.sandbox_error', 'true')
			scope.setContext('mcp', {
				baseUrl: payload.baseUrl,
				hasUser: payload.hasUser,
				durationMs: payload.durationMs,
				errorName: payload.errorName,
				errorMessage: payload.errorMessage,
				registeredCapabilityCount: payload.registeredCapabilityCount,
			})

			if (cause instanceof Error) {
				Sentry.captureException(cause)
			} else if (
				payload.errorMessage != null &&
				payload.errorMessage.length > 0
			) {
				Sentry.captureMessage(
					`${payload.errorName ?? 'Error'}: ${payload.errorMessage}`,
				)
			}
		})
	} catch {
		// Never let observability break MCP execution.
	}
}

export function logMcpEvent(event: LogMcpEventInput) {
	const { cause, ...rest } = event
	try {
		const payload: McpObservabilityPayload = {
			...rest,
			timestamp: event.timestamp ?? new Date().toISOString(),
		}
		console.info('mcp-event', JSON.stringify(payload))
		if (payload.outcome === 'failure') {
			reportMcpFailureToSentry(payload, cause)
		}
	} catch (error) {
		console.warn('mcp-event-failed', error)
	}
}
