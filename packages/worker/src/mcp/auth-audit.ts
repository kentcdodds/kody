import { logAuditEvent } from '#worker/audit-log.ts'

/**
 * Why MCP auth denials go to the audit log instead of Sentry.
 *
 * A single denial is a conversation turn: an agent calls something it is not
 * allowed to call, reads the message, and corrects itself. Reporting each one
 * as an error creates issues that look like platform bugs. But this is also the
 * only place we would see a token being replayed or a principal walking the
 * capability surface, so dropping them outright trades noise for a blind spot.
 *
 * The audit log already resolves that tension for browser and OAuth sign-in
 * failures: identifiers are hashed, rows keep for 180 days, admins can query
 * them, and `/admin/insights` charts failures per day and per hour. Recording
 * denials there keeps the error stream clean while a burst still shows up as a
 * spike on a chart that already exists.
 *
 * Only denials that resolve to a principal are recorded. Anonymous rejections
 * are reachable by anyone and would let a stranger drive unbounded writes, so
 * `/mcp` deliberately drops them rather than auditing them.
 */
export type McpAuthDenialReason =
	| 'unidentified_grant'
	| 'email_unverified'
	| 'account_suspended'
	| 'no_user'
	| 'role'
	| 'permission'
	| 'feature_flag'
	| 'denied'

export async function recordMcpAuthDenial(input: {
	db?: D1Database | null
	action: 'mcp_token_rejected' | 'mcp_capability_denied'
	reason: McpAuthDenialReason
	/** Hashed by the audit sink; the raw value is never stored. */
	email?: string
	ip?: string | null
	/** Capability name for a denial, request path for a token rejection. */
	path?: string
}) {
	await logAuditEvent({
		db: input.db,
		category: 'auth',
		action: input.action,
		result: 'failure',
		reason: input.reason,
		email: input.email,
		ip: input.ip ?? undefined,
		path: input.path,
	})
}
