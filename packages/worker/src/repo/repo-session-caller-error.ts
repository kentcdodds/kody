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
