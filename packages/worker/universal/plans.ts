/**
 * Plan definitions and per-plan resource limits.
 *
 * First-class plans include `max`. Writers persist a plan name (never NULL).
 * After the plan CHECK constraints, reads resolve stored values to
 * {@link PlanName} via strict {@link parseStoredPlanName}. Unexpected values
 * indicate schema corruption and throw instead of granting a plan. Untrusted
 * admin/API input uses {@link parsePlanName} so invalid input can be rejected
 * without throwing. Stripe metadata uses {@link parseStripePlanName}, which
 * rejects `max` (manual-only).
 *
 * There is deliberately no uncapped plan: the live registry is finite `max`
 * only.
 */

export const planNames = ['free', 'standard', 'pro', 'max'] as const

export type PlanName = (typeof planNames)[number]

/**
 * Strict plan-name parser for untrusted admin/API input validation.
 * Unknown strings, typos, retired plan names, nullish values, and
 * non-strings return null so callers can reject them.
 */
export function parsePlanName(value: unknown): PlanName | null {
	return typeof value === 'string' &&
		(planNames as ReadonlyArray<string>).includes(value)
		? (value as PlanName)
		: null
}

/**
 * Parse a plan value read from a stored `users.plan` (or equivalent) column.
 *
 * Unlike {@link parsePlanName}, which returns null for expected invalid
 * untrusted input, this helper throws when persisted data violates the schema
 * contract. The error deliberately omits the raw value and user identifiers.
 */
export function parseStoredPlanName(value: unknown): PlanName {
	const plan = parsePlanName(value)
	if (plan) return plan
	throw new Error('Stored plan is not a registered plan name.')
}

/**
 * Parse a plan name that may come from Stripe subscription metadata
 * (`kody_plan`) or `users.stripe_plan`. `max` is manual-only (never
 * purchasable or Stripe-sourced); unknown values contribute nothing.
 */
export function parseStripePlanName(value: unknown): PlanName | null {
	const plan = parsePlanName(value)
	return plan === 'max' ? null : plan
}

/**
 * Coerce admin/API nullish plan inputs to the default `free` plan used for
 * normal creation and reset paths (signup, invites, admin/platform seeds).
 * Production writers must never persist NULL. Explicit `max` remains a
 * valid deliberate assignment.
 */
export function resolvePlanWrite(plan: PlanName | null | undefined): PlanName {
	return plan ?? 'free'
}

/**
 * Rank order for comparing manual grants vs Stripe subscription plans.
 * Higher rank wins. free(0) < standard(1) < pro(2) < max(3).
 */
export function getPlanRank(plan: PlanName): number {
	switch (plan) {
		case 'free':
			return 0
		case 'standard':
			return 1
		case 'pro':
			return 2
		case 'max':
			return 3
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown plan: ${String(exhaustive)}`)
		}
	}
}

/**
 * Effective plan for entitlement enforcement.
 *
 * - Manual arg is a non-null {@link PlanName} (callers resolve stored values
 *   with {@link parseStoredPlanName} first).
 * - Higher-ranked of manual and stripe plans wins (`max` ranks highest).
 * - Unknown, NULL, `max`, or retired stripe_plan values contribute nothing.
 */
export function resolveEffectivePlan(
	manualPlan: PlanName,
	stripePlan: string | null,
): PlanName {
	const parsedStripe = parseStripePlanName(stripePlan)
	if (!parsedStripe) return manualPlan
	return getPlanRank(parsedStripe) > getPlanRank(manualPlan)
		? parsedStripe
		: manualPlan
}

export type PlanLimits = {
	/** Maximum plain repos (rows in user_repos). */
	maxRepos: number
	/** Maximum saved packages (rows in saved_packages). */
	maxSavedPackages: number
	/** Maximum scheduled jobs (rows in jobs). */
	maxScheduledJobs: number
	/** Maximum active repo sessions (repo_sessions with status 'active'). */
	maxRepoSessions: number
	/** Maximum outbound email send attempts per UTC day. */
	maxEmailSendsPerDay: number
	/** Maximum stored inbound email receipts per UTC day. */
	maxEmailReceivesPerDay: number
	/** Maximum stored email messages (Mailbox DO email_messages rows). */
	maxStoredEmailMessages: number
	/**
	 * Maximum raw MIME bytes persisted for a single email message. Inbound
	 * mail above this is reduced (text kept, oversized parts omitted) up to
	 * the 25 MiB Email Routing survive ceiling. Extracted text/html still
	 * live on the Mailbox email_messages row and are truncated for restore
	 * safety. This persist bound stays well under ~1 MB regardless of plan.
	 */
	maxEmailMessageBytes: number
	/** Maximum stored secret entries across non-expired buckets. */
	maxSecrets: number
	/** Maximum durable storage bytes across enforced storage surfaces. */
	maxStorageBytes: number
	/** Maximum concurrently active workflow runs. */
	maxConcurrentWorkflows: number
	/** Maximum MCP execute-tool runs per UTC day. */
	maxExecuteCallsPerDay: number
	/**
	 * Maximum sandbox outbound fetches (through the fetch gateway) per UTC
	 * day. Bounds cost abuse and third-party hammering from user code; the
	 * shared Worker egress identity means one user's fetch flood can burn
	 * reputation for the whole deployment.
	 */
	maxOutboundFetchesPerDay: number
	/**
	 * Maximum scheduled-job executions per UTC day (cron, interval, and
	 * run-now). Separate from `maxScheduledJobs` (how many job rows you may
	 * own) so a handful of minutely jobs cannot burn unbounded compute.
	 */
	maxJobRunsPerDay: number
	/**
	 * Fastest allowed recurring job interval on this plan. `0` means no extra
	 * floor beyond the schedule itself. Enforced when a schedule is created
	 * or changed — existing faster jobs are grandfathered.
	 */
	minJobIntervalMs: number
}

export const entitlementResources = [
	'repos',
	'saved_packages',
	'scheduled_jobs',
	'repo_sessions',
	'email_sends_per_day',
	'email_receives_per_day',
	'stored_email_messages',
	'email_message_bytes',
	'secrets',
	'storage_bytes',
	'concurrent_workflows',
	'execute_calls_per_day',
	'outbound_fetches_per_day',
	'job_runs_per_day',
] as const

export type EntitlementResource = (typeof entitlementResources)[number]

/** Human-readable resource labels used in the shared error message. */
export const entitlementResourceLabels: Record<EntitlementResource, string> = {
	repos: 'repos',
	saved_packages: 'saved packages',
	scheduled_jobs: 'scheduled jobs',
	repo_sessions: 'active repo sessions',
	email_sends_per_day: 'email sends per day',
	email_receives_per_day: 'email receives per day',
	stored_email_messages: 'stored email messages',
	email_message_bytes: 'bytes per email message',
	secrets: 'secrets',
	storage_bytes: 'storage bytes',
	concurrent_workflows: 'concurrent workflows',
	execute_calls_per_day: 'execute calls per day',
	outbound_fetches_per_day: 'outbound fetches per day',
	job_runs_per_day: 'job runs per day',
}

/**
 * Email caps for the first-class `max` plan. Email is abuse-sensitive in
 * both directions — inbound volume is attacker-controlled (anyone can send
 * to a `{username}@<platform domain>` address) and outbound sending is an
 * outreach-abuse surface — so `max` is not uncapped for mail. These are
 * intentional abuse backstops (not the ordinary 100×-pro derivation used
 * for other max ceilings), but they dominate every other plan's email
 * limits so granting `max` never reduces a user's email capacity.
 * `email_message_bytes` is pinned to standard/pro parity because the
 * per-message persist ceiling is a platform bound (see the PlanLimits
 * field doc), not a scalable quota. Larger inbound mail is reduced to
 * this size instead of raising the stored-MIME ceiling.
 */
export const maxPlanEmailLimits = {
	email_sends_per_day: 10_000,
	email_receives_per_day: 20_000,
	stored_email_messages: 100_000,
	email_message_bytes: 768 * 1024,
} as const satisfies Partial<Record<EntitlementResource, number>>

/**
 * Limit numbers are denial-of-wallet caps, tuned from production metering
 * (August 2026). The expensive surface is MCP `execute`: each unique
 * Dynamic Worker id is $0.002/UTC day after the account-wide included
 * allotment. Billing (`packages/worker/src/billing/`) maps Stripe
 * subscriptions onto these plan names; the limit numbers stay independent
 * of list prices.
 *
 * Ordinary `max` stock ceilings are explicit product choices based on the
 * `pro` plan (often 25× or 50×). Compute rate limits on `max` are operator
 * runaway caps sized from production usage with at least 2× busy-day
 * headroom, and they still dominate every paid plan. Email resources use
 * {@link maxPlanEmailLimits} abuse caps instead.
 */
export const planLimits: Record<PlanName, PlanLimits> = {
	// Free stays roomy for setup (secrets, a handful of jobs) and tighter on
	// rates / live compute — the real cost and the upgrade story. Packages
	// sit at 10 so a serious catalog wants Standard; secrets stay at 25
	// because one OAuth integration commonly needs three entries (client
	// secret, access token, refresh token).
	free: {
		maxRepos: 20,
		maxSavedPackages: 10,
		maxScheduledJobs: 5,
		// Sessions are cheap (catalog row + dormant DO workspace + Artifacts
		// branch). Unused (never-checkpointed) leftovers sweep after 30
		// minutes idle; checkpointed sessions use the 7-day window so
		// unpublished work is not lost mid-conversation. Sized for a couple
		// of concurrent agent conversations, not a leftover pile.
		maxRepoSessions: 5,
		// notify-self and reply-to-stored only, so the outreach-abuse surface
		// is small; a daily digest plus a few alerts should not hit the wall.
		maxEmailSendsPerDay: 10,
		// Inbound volume is attacker-controlled. Free inbound is unused in
		// production; keep a small mailbox so a leaked address cannot fill
		// storage.
		maxEmailReceivesPerDay: 10,
		maxStoredEmailMessages: 100,
		maxEmailMessageBytes: 256 * 1024,
		maxSecrets: 25,
		maxStorageBytes: 16 * 1024 * 1024,
		// Concurrent active runs (not lifetime or daily). One at a time on
		// free; a second deferred workflow is the upgrade nudge.
		maxConcurrentWorkflows: 1,
		// Unique execute is the Dynamic Worker bill. 100/day covers a real
		// agent morning (~70 observed) without pricing a free account at
		// Standard's unique-execute ceiling.
		maxExecuteCallsPerDay: 100,
		maxOutboundFetchesPerDay: 500,
		maxJobRunsPerDay: 500,
		minJobIntervalMs: 15 * 60 * 1000,
	},
	standard: {
		maxRepos: 200,
		maxSavedPackages: 100,
		maxScheduledJobs: 50,
		maxRepoSessions: 200,
		maxEmailSendsPerDay: 200,
		maxEmailReceivesPerDay: 1_000,
		maxStoredEmailMessages: 10_000,
		maxEmailMessageBytes: 768 * 1024,
		maxSecrets: 100,
		maxStorageBytes: 1024 * 1024 * 1024,
		maxConcurrentWorkflows: 50,
		// Above the heaviest Standard payer (~200/day avg). Unique-execute
		// ceiling is still above list price if someone maxes new modules.
		maxExecuteCallsPerDay: 500,
		maxOutboundFetchesPerDay: 20_000,
		maxJobRunsPerDay: 10_000,
		minJobIntervalMs: 0,
	},
	pro: {
		maxRepos: 400,
		maxSavedPackages: 200,
		maxScheduledJobs: 150,
		maxRepoSessions: 400,
		maxEmailSendsPerDay: 500,
		maxEmailReceivesPerDay: 2_000,
		maxStoredEmailMessages: 25_000,
		maxEmailMessageBytes: 768 * 1024,
		maxSecrets: 200,
		maxStorageBytes: 5 * 1024 * 1024 * 1024,
		maxConcurrentWorkflows: 100,
		// Above the heaviest Pro payer (~670/day August avg) with room
		// for a busy day. Unique-execute ceiling at 800/day is about
		// the $49 list price ($0.002 × 800 × 30 ≈ $48).
		maxExecuteCallsPerDay: 800,
		maxOutboundFetchesPerDay: 40_000,
		maxJobRunsPerDay: 20_000,
		minJobIntervalMs: 0,
	},
	max: {
		// 25× pro (400) → 10_000.
		maxRepos: 10_000,
		// 50× pro (200) → 10_000.
		maxSavedPackages: 10_000,
		// Product ceiling (about 33× pro).
		maxScheduledJobs: 5_000,
		// 50× pro (400) → 20_000.
		maxRepoSessions: 20_000,
		// Inherited abuse caps (not 100× pro); see maxPlanEmailLimits.
		maxEmailSendsPerDay: maxPlanEmailLimits.email_sends_per_day,
		maxEmailReceivesPerDay: maxPlanEmailLimits.email_receives_per_day,
		maxStoredEmailMessages: maxPlanEmailLimits.stored_email_messages,
		maxEmailMessageBytes: maxPlanEmailLimits.email_message_bytes,
		// 50× pro (200) → 10_000.
		maxSecrets: 10_000,
		// 20× pro (5 GiB) → 100 GiB.
		maxStorageBytes: 100 * 1024 * 1024 * 1024,
		// 2× pro (100). Observed concurrent ~35.
		maxConcurrentWorkflows: 200,
		// Operator runaway cap. kentcdodds August 2026 rollup avg ~3,800
		// execute/day (116k/month); entitlement meter today ~1,810. Daily
		// peak is not stored; 25,000 is at least 2× a ~12,500 peak (~3×
		// August avg). Unique-DW ceiling is $50/day ($0.002 × 25,000).
		maxExecuteCallsPerDay: 25_000,
		// 2× pro (40_000). Today's fetch spike (~17,000) stays well under.
		maxOutboundFetchesPerDay: 80_000,
		// 2× pro (20_000). Busy days are ~1,500–1,700 job runs.
		maxJobRunsPerDay: 40_000,
		minJobIntervalMs: 0,
	},
}

/** 15-minute floor on free recurring jobs. Paid plans have no extra floor. */
export const freeMinJobIntervalMs = planLimits.free.minJobIntervalMs

/**
 * Human label for a plan's fastest job interval. `0` means no extra floor.
 */
export function formatMinJobInterval(minJobIntervalMs: number): string {
	if (minJobIntervalMs <= 0) return 'None'
	const minuteMs = 60 * 1000
	const hourMs = 60 * minuteMs
	if (minJobIntervalMs % hourMs === 0) {
		const hours = minJobIntervalMs / hourMs
		return hours === 1 ? '1 hour' : `${hours} hours`
	}
	if (minJobIntervalMs % minuteMs === 0) {
		const minutes = minJobIntervalMs / minuteMs
		return minutes === 1 ? '1 minute' : `${minutes} minutes`
	}
	return `${minJobIntervalMs} ms`
}

/**
 * Resolve the numeric limit for a resource under a plan. Every plan limit is
 * finite.
 */
export function resolvePlanLimit(
	plan: PlanName,
	resource: EntitlementResource,
): number {
	const limits = planLimits[plan]
	switch (resource) {
		case 'repos':
			return limits.maxRepos
		case 'saved_packages':
			return limits.maxSavedPackages
		case 'scheduled_jobs':
			return limits.maxScheduledJobs
		case 'repo_sessions':
			return limits.maxRepoSessions
		case 'email_sends_per_day':
			return limits.maxEmailSendsPerDay
		case 'email_receives_per_day':
			return limits.maxEmailReceivesPerDay
		case 'stored_email_messages':
			return limits.maxStoredEmailMessages
		case 'email_message_bytes':
			return limits.maxEmailMessageBytes
		case 'secrets':
			return limits.maxSecrets
		case 'storage_bytes':
			return limits.maxStorageBytes
		case 'concurrent_workflows':
			return limits.maxConcurrentWorkflows
		case 'execute_calls_per_day':
			return limits.maxExecuteCallsPerDay
		case 'outbound_fetches_per_day':
			return limits.maxOutboundFetchesPerDay
		case 'job_runs_per_day':
			return limits.maxJobRunsPerDay
		default: {
			const exhaustive: never = resource
			throw new Error(`Unknown entitlement resource: ${String(exhaustive)}`)
		}
	}
}
