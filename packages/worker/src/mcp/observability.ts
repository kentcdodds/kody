import * as Sentry from '@sentry/cloudflare'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { getErrorCauseChain } from '@kody-internal/shared/error-message.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { isRemoteConnectorUnavailableMessage } from '#worker/remote-connector/status.ts'
import { isRepoLargeFileMessage } from '#worker/repo/large-file-policy.ts'
import { isUserStorageSqlCallerMessage } from '#worker/storage-sql-caller-error.ts'
import { isUserCodeError } from '#worker/user-code-error.ts'
import { isMcpCallerError } from './caller-error.ts'

export type McpToolKind = 'search' | 'execute' | 'capability' | 'app'

export type McpFailurePhase = 'parse_input' | 'handler' | 'parse_output'

export type McpObservabilityPayload = {
	category: 'mcp'
	tool: McpToolKind
	toolName?: string
	capabilityName?: string
	domain?: string
	capabilitySource?: string
	outcome: 'success' | 'failure'
	durationMs: number
	baseUrl: string
	hasUser: boolean
	/** Stable user id of the caller, when authenticated. */
	userId?: string
	/**
	 * MCP tool conversation id when the call is part of a multi-turn tool
	 * session. Kept on context (not tags) to avoid high-cardinality indexing.
	 */
	conversationId?: string
	/**
	 * Bound durable storage id for execute/capability calls that run against a
	 * specific bucket. Kept on context (not tags) for the same reason.
	 */
	storageId?: string
	failurePhase?: McpFailurePhase
	sandboxError?: boolean
	/**
	 * Set at failure sites that report a caller mistake without throwing an
	 * `McpCallerError` (batch lookups, early argument validation).
	 */
	callerError?: boolean
	registeredCapabilityCount?: number
	errorName?: string
	errorMessage?: string
	message?: string
	context?: Record<string, unknown>
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
		userId: context.user?.userId,
		storageContext: context.storageContext ?? null,
		storageId: context.storageContext?.storageId ?? undefined,
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

/**
 * Failures the caller caused and can fix. They stay on the structured
 * `mcp-event` log line; sending them to Sentry creates issues that look like
 * platform bugs and trip triage automation.
 *
 * Plan-limit denials (`EntitlementLimitError`) belong here too: the user can
 * clean up or upgrade, and volume is still visible on `mcp-event` lines if a
 * spike ever needs investigation.
 */
function isCallerFailure(payload: McpObservabilityPayload, cause?: unknown) {
	// Sandbox failures come from caller-supplied module code (bad Notion
	// filters, syntax errors, thrown strings).
	if (payload.sandboxError) return true
	// Arguments that never matched the declared schema never reached a handler.
	if (payload.failurePhase === 'parse_input') return true
	if (payload.callerError) return true
	if (isUserCodeError(cause)) return true
	if (getErrorCauseChain(cause).some(isEntitlementLimitError)) return true
	// Community preconditions (rate before fork, self-rate, banned, …) are
	// caller-clearable; keep them on mcp-event and out of Sentry.
	if (
		getErrorCauseChain(cause).some(
			(entry) => entry instanceof CommunityActionError,
		)
	) {
		return true
	}
	// Repo large-file rejections raised inside the RepoSession Durable Object
	// arrive as plain Errors (subclass identity does not survive RPC); match
	// on the stable message phrase so caller-fixable size denials stay out of
	// Sentry.
	if (
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error && isRepoLargeFileMessage(entry.message),
		)
	) {
		return true
	}
	// Offline / empty / session-unavailable remote connectors throw a plain
	// Error with a stable guidance message. Agents reconnect; keep volume on
	// mcp-event lines.
	if (
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error &&
				isRemoteConnectorUnavailableMessage(entry.message),
		)
	) {
		return true
	}
	// User-authored SQL against a storage bucket (missing tables/columns,
	// constraints, read-only policy). storage_query wraps these as
	// McpCallerError; this message match covers plain Errors that still
	// arrive via RPC without subclass identity.
	if (
		getErrorCauseChain(cause).some(
			(entry) =>
				entry instanceof Error && isUserStorageSqlCallerMessage(entry.message),
		)
	) {
		return true
	}
	return isMcpCallerError(cause)
}

function reportMcpFailureToSentry(
	payload: McpObservabilityPayload,
	cause?: unknown,
) {
	try {
		if (isCallerFailure(payload, cause)) return
		if (!Sentry.isInitialized()) return
		const client = Sentry.getClient()
		if (!client?.getOptions().dsn) return

		Sentry.withScope((scope) => {
			scope.setLevel('error')

			// Id only: sendDefaultPii is false and emails stay out of Sentry.
			if (payload.userId) scope.setUser({ id: payload.userId })

			scope.setTag('mcp.tool', payload.tool)
			if (payload.toolName) scope.setTag('mcp.tool_name', payload.toolName)
			if (payload.capabilityName) {
				scope.setTag('mcp.capability', payload.capabilityName)
			}
			if (payload.domain) scope.setTag('mcp.domain', payload.domain)
			if (payload.capabilitySource) {
				scope.setTag('mcp.capability_source', payload.capabilitySource)
			}
			if (payload.failurePhase) {
				scope.setTag('mcp.failure_phase', payload.failurePhase)
			}
			scope.setContext('mcp', {
				baseUrl: payload.baseUrl,
				hasUser: payload.hasUser,
				durationMs: payload.durationMs,
				errorName: payload.errorName,
				errorMessage: payload.errorMessage,
				registeredCapabilityCount: payload.registeredCapabilityCount,
				conversationId: payload.conversationId,
				storageId: payload.storageId,
				// Structured call-site detail (entity refs, validation phase,
				// intent telemetry). Nested so it cannot clobber core fields.
				detail: payload.context,
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
