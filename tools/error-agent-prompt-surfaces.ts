/**
 * Inventory of agent-blind website/email error surfaces that must stamp
 * `data-error-agent-prompt` (via the shared primitive). Surfaces the agent
 * already sees through MCP/CLI stay in `skip` with a reason.
 *
 * When you add a new user-facing error UI the agent cannot already see, add
 * the file here under `adopt` and use `#universal/error-agent-prompt` /
 * `#client/error-agent-prompt-button`. See
 * docs/principles/error-prompt-for-agents.md.
 */

export type ErrorAgentPromptSkip = {
	file: string
	reason: string
}

/** Files that must include the `data-error-agent-prompt` marker. */
export const errorAgentPromptAdoptFiles = [
	'packages/worker/client/internal-error-page.tsx',
	'packages/worker/client/not-found-page.tsx',
	'packages/worker/client/app.tsx',
	'packages/worker/client/error-agent-prompt-button.tsx',
	'packages/worker/client/routes/connect-oauth-sections.tsx',
	'packages/worker/client/routes/connect-secrets.tsx',
	'packages/worker/client/routes/connect-secret-set.tsx',
	'packages/worker/client/routes/connect-webhook-apply.tsx',
	'packages/worker/client/routes/account-secrets-approval.tsx',
	'packages/worker/client/routes/account-package-approve-publish.tsx',
	'packages/worker/client/routes/login.tsx',
	'packages/worker/client/routes/oauth-authorize.tsx',
	'packages/worker/client/routes/account-billing.tsx',
	'packages/worker/client/routes/discord.tsx',
	'packages/worker/client/routes/verify-email.tsx',
	'packages/worker/client/routes/org-invite-join.tsx',
	'packages/worker/src/app/internal-error-page.ts',
	'packages/worker/src/package-runtime/package-app-serve.ts',
	'packages/worker/src/app/email/messages.ts',
] as const

/**
 * Known error UIs that intentionally omit the primitive. Keep reasons short.
 * MCP-mirror account CRUD toasts/messages are omitted from this list entirely
 * (they are not scanned as adopt candidates).
 */
export const errorAgentPromptSkipFiles: ReadonlyArray<ErrorAgentPromptSkip> = [
	{
		file: 'packages/worker/src/app/handlers/error-pages.ts',
		reason:
			'SSR handlers only; illustrated UI lives in InternalErrorPage / NotFoundPage.',
	},
	{
		file: 'packages/worker/client/illustrated-error-page.ts',
		reason: 'Shared CSS helpers only; not a user-facing error surface.',
	},
	{
		file: 'packages/worker/universal/internal-error-page.ts',
		reason: 'Shared 500 copy constants only; not a user-facing error surface.',
	},
	{
		file: 'packages/worker/client/routes/account-activity-detail.tsx',
		reason: 'Agent already has runGet for the same error text.',
	},
	{
		file: 'packages/worker/client/routes/account-activity.tsx',
		reason:
			'List already ships a triage Copy prompt; runGet covers detail errors.',
	},
	{
		file: 'packages/worker/client/routes/account-jobs-detail.tsx',
		reason: 'Agent already has jobGet / runGet.',
	},
	{
		file: 'packages/worker/client/routes/account-jobs.tsx',
		reason: 'Agent already has jobList / job actions.',
	},
	{
		file: 'packages/worker/client/routes/account-webhooks.tsx',
		reason: 'Agent already has webhookList.',
	},
	{
		file: 'packages/worker/client/routes/account-workflows.tsx',
		reason: 'Agent already has workflow capabilities.',
	},
]

/** Marker every adopt file must contain (attribute or string constant). */
export const errorAgentPromptMarker = 'data-error-agent-prompt'

/**
 * Filename / path patterns that look like dedicated error pages. A new match
 * outside adopt+skip fails the guard so someone classifies it.
 */
export const errorAgentPromptCandidatePatterns = [
	/(^|\/)internal-error-page\./,
	/(^|\/)not-found-page\./,
	/package-app-serve\./,
	// New dedicated *error-page* modules must be classified in adopt or skip.
	/(^|\/)[\w-]*error-page\./,
] as const
