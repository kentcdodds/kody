import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'

/**
 * A failure the caller can clear from the message alone: a missing or
 * conflicting argument, an id that does not resolve, a precondition the caller
 * has to undo first. Kody's MCP surface is agent-facing, so these are routine
 * conversation turns rather than defects — they stay on the `mcp-event` log
 * line and out of Sentry, where they open issues that look like platform bugs
 * and trip triage automation.
 */
export class McpCallerError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options)
		this.name = 'McpCallerError'
	}
}

export function isMcpCallerError(error: unknown) {
	return getErrorCauseChain(error).some(
		(entry) => entry instanceof McpCallerError,
	)
}
