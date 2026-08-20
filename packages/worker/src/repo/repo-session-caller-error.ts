/**
 * Stable phrase from RepoSession DO `requireSession` when a session is no
 * longer `active` (typically `published`). Subclass identity does not survive
 * Durable Object RPC, so MCP observability matches this phrase to keep those
 * expected workflow misses on `mcp-event` and out of Sentry.
 */
export const repoSessionInactiveMessagePhrase =
	'; open a new session before continuing.'

export function isRepoSessionInactiveMessage(message: string) {
	return (
		message.startsWith('Repo session "') &&
		message.includes(repoSessionInactiveMessagePhrase)
	)
}

/**
 * isomorphic-git `PushRejectedError` for non-fast-forward pushes. Publish maps
 * these to `base_moved` so agents rebase; when a plain Error still escapes DO
 * RPC (subclass identity lost), MCP observability matches this phrase.
 * KODY-CLOUDFLARE-5M.
 */
export const gitPushNotFastForwardMessagePhrase = 'not a simple fast-forward'

export function isGitPushNotFastForwardMessage(message: string) {
	return message.includes(gitPushNotFastForwardMessagePhrase)
}

export function isGitPushNotFastForwardError(error: unknown) {
	if (typeof error !== 'object' || error === null) return false
	const name =
		'name' in error && typeof error.name === 'string' ? error.name : null
	const code =
		'code' in error && typeof error.code === 'string' ? error.code : null
	if (name === 'PushRejectedError' || code === 'PushRejectedError') {
		const message =
			'message' in error && typeof error.message === 'string'
				? error.message
				: ''
		// tag-exists uses the same error class; only treat non-FF as recoverable.
		return message.length === 0 || isGitPushNotFastForwardMessage(message)
	}
	if (!('message' in error) || typeof error.message !== 'string') return false
	return isGitPushNotFastForwardMessage(error.message)
}

/**
 * Stable prefix for invalid `mode=regex` patterns from repo session search.
 * Agents often pass Python/PCRE inline flags (`(?s)`, `(?i)`) that JavaScript
 * RegExp rejects; treat those as caller-correctable input, not platform bugs.
 */
export const repoSearchInvalidRegexMessagePrefix =
	'repo_search received an invalid regex'

export function isRepoSearchInvalidRegexMessage(message: string) {
	return message.startsWith(repoSearchInvalidRegexMessagePrefix)
}

export function buildRepoSearchInvalidRegexCallerMessage(
	compileMessage: string,
) {
	return (
		`${repoSearchInvalidRegexMessagePrefix}: ${compileMessage}. ` +
		'mode=regex uses JavaScript RegExp syntax (no inline flags like (?s) or (?i); ' +
		'for dotall matching use [\\s\\S] instead of `.` with (?s)).'
	)
}
