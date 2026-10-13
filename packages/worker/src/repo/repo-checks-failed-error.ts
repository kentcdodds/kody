import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	formatFailedRepoCheckMessages,
	type RepoCheckResult,
} from './checks.ts'

/**
 * Stable Error.name for failed publish/repo checks (typecheck, docs, bundle
 * validation, …). Subclass identity does not survive Durable Object RPC, so
 * callers match this name (and the JSRPC-flattened `Name: message` prefix) to
 * keep expected agent-correctable failures off Sentry. KODY-96.
 */
export const repoChecksFailedErrorName = 'RepoChecksFailedError'

/**
 * Thrown when `runRepoChecks` / `session.runChecks` returns `ok: false`.
 * Message is the joined check diagnostics agents need to fix the package.
 */
export class RepoChecksFailedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = repoChecksFailedErrorName
	}
}

export function createRepoChecksFailedError(
	results: ReadonlyArray<RepoCheckResult>,
	fallback = 'Publish checks failed.',
) {
	return new RepoChecksFailedError(
		formatFailedRepoCheckMessages(results, fallback),
	)
}

/**
 * True for a live `RepoChecksFailedError`, or the same failure after DO / JSRPC
 * flattened it to a plain Error that kept `name` or prefixed the message.
 */
export function isRepoChecksFailedError(error: unknown): boolean {
	if (error instanceof RepoChecksFailedError) return true
	if (error === null || typeof error !== 'object') return false
	const candidate = error as { name?: unknown; message?: unknown }
	if (candidate.name === repoChecksFailedErrorName) return true
	// JSRPC may flatten the class so `name` is Error and the message is
	// `RepoChecksFailedError: <diagnostics>`.
	return (
		typeof candidate.message === 'string' &&
		candidate.message.startsWith(`${repoChecksFailedErrorName}:`)
	)
}

/** Agent-facing diagnostics, stripping a JSRPC name prefix when present. */
export function repoChecksFailedCallerMessage(error: unknown): string {
	const message = getErrorMessage(error)
	const prefix = `${repoChecksFailedErrorName}: `
	return message.startsWith(prefix) ? message.slice(prefix.length) : message
}
