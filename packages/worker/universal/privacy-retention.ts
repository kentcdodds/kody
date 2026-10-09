/**
 * Fixed copy shared by `/privacy` and `docs/use/privacy.md`. The markdown
 * repeats each list verbatim as bullets; `privacy-retention.node.test.ts`
 * fails when either list drifts.
 */
export const privacyRetentionPeriods: ReadonlyArray<string> = [
	'Email delivery events: 90 days',
	'Email messages and their attachments: 365 days',
	'Completed workflow runs and conversation-suppression records: 90 days',
	'Resolved or dismissed platform feedback: 365 days after its last update; open or triaged feedback remains until it is resolved, dismissed, or the account is deleted',
	'Audit events: 180 days',
	'Feature-flag exposure records: 90 days',
	'Daily entitlement counters: 400 days',
	'Monthly usage rollups: 24 months',
	'Durable Object duration attribution: until account deletion',
	'Stripe webhook event records: 30 days',
	'Non-current published bundle artifacts: at least 30 days, then eligible for removal when no active source or repo session needs them',
	'Unverified person accounts: seven days after signup when the email is still unverified and no sign-in provider is linked',
]

export const privacySubprocessors: ReadonlyArray<string> = [
	'Cloudflare — application hosting, database, object storage, email delivery, security, network infrastructure, and Workers AI embeddings and ranked-search scoring',
	'Stripe — paid subscriptions, billing, and payment records',
	'Kit — product email subscriptions when you submit your email for those purposes',
	'Sentry — application error reporting and operational diagnostics',
	'Fathom — privacy-focused website traffic analytics',
	'Scarf — company-level analytics on public marketing pages and docs. We send the public page path, without query strings or fragments. Scarf uses the request IP address to identify companies, discards the raw IP address, and does not set cookies. We skip these requests when your browser sends Global Privacy Control or Do Not Track.',
]
