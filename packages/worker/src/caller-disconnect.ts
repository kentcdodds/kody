import { isExecutorSandboxTimeoutMessage } from '#worker/sentry-options.ts'

/** Run-record `errorName` when the inbound caller aborts a keyed package invocation. */
export const packageInvocationClientDisconnectedErrorName =
	'client_disconnected'

/**
 * Written on the eager run row at claim, before sandbox work. A later isolate
 * kill still leaves this line, so reconciliation to `platform_interrupted` is
 * not an empty log.
 */
export function packageInvocationStartedLog(name: string | null | undefined) {
	const label = name?.trim() || 'package invocation'
	return `package invocation started: ${label}`
}

export function createPackageInvocationClientDisconnectedError() {
	const error = new Error(
		'The caller disconnected before this package invocation finished. The attempt was stopped and recorded so it does not stay running without logs. Retry with a new idempotency key.',
	)
	error.name = packageInvocationClientDisconnectedErrorName
	return error
}

/** Sandbox result text when the inbound request abort stops execute. */
export const callerDisconnectedSandboxMessage =
	'The caller disconnected before the sandbox finished. The run was stopped and recorded so it does not stay running without logs. Retry with a new idempotency key.'

export const callerDisconnectedSandboxLog =
	'caller disconnected before the sandbox finished'

/** Run-record error for execute (and nested sandbox) caller disconnect. */
export function createCallerDisconnectedExecutionError() {
	const error = new Error(callerDisconnectedSandboxMessage)
	error.name = packageInvocationClientDisconnectedErrorName
	return error
}

export function isCallerDisconnectedSandboxMessage(message: string) {
	return message === callerDisconnectedSandboxMessage
}

/**
 * True when `signal` aborted because the inbound caller went away.
 * Sandbox wall-clock timeouts use `TimeoutError` and must keep the normal
 * timeout finish instead of being recorded as a disconnect.
 */
export function isCallerDisconnectAbort(signal: AbortSignal) {
	if (!signal.aborted) return false
	const reason = signal.reason
	if (reason == null || !(reason instanceof Error)) return true
	if (reason.name === 'TimeoutError') return false
	if (isExecutorSandboxTimeoutMessage(reason.message)) return false
	return reason.name === 'AbortError'
}
