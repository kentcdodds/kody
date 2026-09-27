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
 *
 * Standard/Pro ceilings have two ladders: {@link planLimits} is the
 * 2026-09 table (Standard $12 and Pro $49 subscribers, now retired from
 * checkout). {@link legacyPlanLimits} applies only while
 * `users.entitlement_ladder = 'legacy'` and paid access stays continuous.
 *
 * The purchasable Pro (Stripe `STRIPE_PRO_PRICE_ID`, $12) uses
 * {@link proCreditsPlanLimits} and carries the prepaid credit wallet
 * (`users.stripe_credits_eligible`). See {@link CreditWalletState}.
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
 * normal creation and reset paths (signup, admin/platform seeds).
 * Production writers must never persist NULL. Explicit `max` remains a
 * valid deliberate assignment.
 */
export function resolvePlanWrite(plan: PlanName | null | undefined): PlanName {
	return plan ?? 'free'
}

/**
 * Paid product SKUs (Standard, Pro, Max). Free never qualifies.
 * Use for feature gates that are not usage entitlements (for example
 * improved search / Jev). Do not put those features in the entitlement
 * catalog.
 */
export function isPaidPlan(plan: PlanName): boolean {
	return plan !== 'free'
}

/**
 * Whether a higher plan is available as a self-serve upgrade destination.
 *
 * Only Free can upgrade: the purchasable Pro has the retired Standard
 * includes, so switching from retired Standard or Pro does not raise stock
 * limits (it adds the credit wallet instead). Max is manual-only and never a
 * purchase destination.
 */
export function hasHigherPublicPlan(plan: PlanName): boolean {
	switch (plan) {
		case 'free':
			return true
		case 'standard':
		case 'pro':
		case 'max':
			return false
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown plan: ${String(exhaustive)}`)
		}
	}
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

/**
 * Which entitlement ceiling table applies for Standard/Pro.
 *
 * - `public` — the live pricing-page ladder (new subscribers and anyone
 *   who cancels and resubscribes).
 * - `legacy` — the pre-cut Standard/Pro ceilings, kept only while the
 *   same Stripe subscription continues without a plan, price, product, or
 *   interval change, or while a remaining manual Pro grant is already
 *   flagged. Never inferred from join date.
 */
export const entitlementLadders = ['public', 'legacy'] as const

export type EntitlementLadder = (typeof entitlementLadders)[number]

/**
 * Parse a stored `users.entitlement_ladder` value. Missing/blank values
 * (pre-migration test fixtures) resolve to `public`. Unexpected values
 * throw without echoing the raw value.
 */
export function parseEntitlementLadder(value: unknown): EntitlementLadder {
	if (value == null || value === '') return 'public'
	if (
		typeof value === 'string' &&
		(entitlementLadders as ReadonlyArray<string>).includes(value)
	) {
		return value as EntitlementLadder
	}
	throw new Error('Stored entitlement ladder is not a registered ladder name.')
}

function isPaidStripePlan(plan: PlanName | null): plan is 'standard' | 'pro' {
	return plan === 'standard' || plan === 'pro'
}

function normalizeStripePriceId(value: string | null | undefined): string {
	return value?.trim() ?? ''
}

/**
 * Drop `legacy` when continuous paid access ends, or when the granting
 * Stripe subscription changes plan, price, product, or interval. Same-plan
 * auto-renew (same price id) keeps `legacy`. The first Stripe refresh after
 * `users.stripe_price_id` is added writes the current price without treating
 * an empty previous value as a change. Never promotes `public` to `legacy`
 * — only the one-shot backfill writes that marker.
 */
export function resolveEntitlementLadderAfterPaidAccessChange(input: {
	currentLadder: EntitlementLadder
	manualPlan: PlanName
	previousStripePlan: PlanName | null
	nextStripePlan: PlanName | null
	previousStripePriceId?: string | null
	nextStripePriceId?: string | null
}): EntitlementLadder {
	if (input.currentLadder !== 'legacy') return 'public'
	if (!isPaidStripePlan(input.nextStripePlan)) {
		return input.manualPlan === 'pro' ? 'legacy' : 'public'
	}
	if (
		isPaidStripePlan(input.previousStripePlan) &&
		input.previousStripePlan !== input.nextStripePlan
	) {
		return 'public'
	}
	const previousPrice = normalizeStripePriceId(input.previousStripePriceId)
	const nextPrice = normalizeStripePriceId(input.nextStripePriceId)
	if (previousPrice !== '' && nextPrice !== '' && previousPrice !== nextPrice) {
		return 'public'
	}
	return 'legacy'
}

/**
 * Prepaid credit wallet state for limit resolution.
 *
 * - `none` — not wallet-eligible (Free, retired Standard/Pro, manual grants,
 *   `max`). Credits never unlock or debit.
 * - `empty` — purchasable Pro with a balance at or below $0. Base
 *   {@link proCreditsPlanLimits} apply (hard caps).
 * - `funded` — purchasable Pro with a balance above $0. Rate/compute limits
 *   in {@link creditsUnlockedLimitFields} are multiplied by
 *   {@link creditsUnlockMultiplier} up to the `max` ceilings; past-include
 *   usage debits the wallet.
 */
export const creditWalletStates = ['none', 'empty', 'funded'] as const

export type CreditWalletState = (typeof creditWalletStates)[number]

export type UserEntitlement = {
	plan: PlanName
	ladder: EntitlementLadder
	creditWallet: CreditWalletState
}

/**
 * Wallet state for an effective plan. Only `pro` granted by the purchasable
 * Pro Stripe price is eligible; a manual `max` grant or any other plan
 * resolves to `none`.
 */
export function resolveCreditWalletState(input: {
	plan: PlanName
	creditsEligible: boolean
	balanceMicroUsd: number | null | undefined
}): CreditWalletState {
	if (input.plan !== 'pro' || !input.creditsEligible) return 'none'
	const balance = input.balanceMicroUsd ?? 0
	return Number.isFinite(balance) && balance > 0 ? 'funded' : 'empty'
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
	 * Maximum MCP execute-tool runs per UTC week (Monday–Sunday). `null`
	 * means no weekly window — daily is the only hard cap. Public
	 * Free/Standard/Pro set a weekly total so a 1–2 day burst cannot spend
	 * a full week of daily headroom. `max` and legacy Standard/Pro leave
	 * this unset so their daily-only behavior stays unchanged.
	 */
	maxExecuteCallsPerWeek: number | null
	/**
	 * Maximum sandbox outbound fetches (through the fetch gateway) per UTC
	 * day. Bounds cost abuse and third-party hammering from user code; the
	 * shared Worker egress identity means one user's fetch flood can burn
	 * reputation for the whole deployment.
	 */
	maxOutboundFetchesPerDay: number
	/**
	 * Maximum sandbox outbound fetches per UTC week (Monday–Sunday).
	 * `null` means no weekly window. Same public-vs-legacy/`max` rule as
	 * {@link PlanLimits.maxExecuteCallsPerWeek}.
	 */
	maxOutboundFetchesPerWeek: number | null
	/**
	 * Maximum scheduled-job executions per UTC day (cron, interval, and
	 * run-now). Separate from `maxScheduledJobs` (how many job rows you may
	 * own) so a handful of minutely jobs cannot burn unbounded compute.
	 */
	maxJobRunsPerDay: number
	/**
	 * Maximum always-on automation invocations per UTC day: inbound
	 * webhooks, HTTP package-export invocations, package subscriptions,
	 * and package-backed workflow steps. Sibling of
	 * {@link PlanLimits.maxExecuteCallsPerDay} (MCP execute only) and
	 * {@link PlanLimits.maxJobRunsPerDay} (scheduled jobs). Daily only —
	 * no weekly window. Public Free sits modestly above job runs. Public
	 * Standard, Pro, and `max` are burst-friendly above job runs. Legacy
	 * Standard/Pro stay at the earlier job-matched ceilings.
	 */
	maxAutomationInvocationsPerDay: number
	/**
	 * Fastest allowed recurring job interval on this plan. `0` means no extra
	 * floor beyond the schedule itself. Enforced when a schedule is created
	 * or changed — existing faster jobs are grandfathered.
	 */
	minJobIntervalMs: number
	/**
	 * Included unique Dynamic Worker days per UTC month. Shown on `/pricing`.
	 * One of the two credit debit meters (with Durable Object rows-read).
	 * Not in `entitlementResources` (no hard cut). Usage above the include
	 * debits a funded Pro wallet and is not charged otherwise. Approaching
	 * and reached warning emails cover this allotment.
	 */
	maxUniqueWorkerDaysPerMonth: number
	/**
	 * Included Durable Object SQLite rows read per UTC month. Shown on
	 * `/pricing`. The other credit debit meter. Not in
	 * `entitlementResources` (no hard cut). No duration meter. Usage above
	 * the include debits a funded Pro wallet and is not charged otherwise.
	 * Approaching and reached warning emails cover this allotment.
	 */
	maxDurableObjectRowsReadPerMonth: number
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
	'automation_invocations_per_day',
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
	automation_invocations_per_day: 'automation invocations per day',
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
		// Unique execute is the Dynamic Worker bill. Daily headroom covers a
		// bursty agent morning; the weekly total keeps a free account from
		// spending a full week of that headroom every day.
		maxExecuteCallsPerDay: 150,
		maxExecuteCallsPerWeek: 400,
		maxOutboundFetchesPerDay: 1_000,
		maxOutboundFetchesPerWeek: 2_500,
		maxJobRunsPerDay: 500,
		// Modestly above job runs (500).
		maxAutomationInvocationsPerDay: 1_000,
		minJobIntervalMs: 15 * 60 * 1000,
		maxUniqueWorkerDaysPerMonth: 50,
		maxDurableObjectRowsReadPerMonth: 500_000_000,
	},
	standard: {
		maxRepos: 200,
		maxSavedPackages: 50,
		maxScheduledJobs: 15,
		maxRepoSessions: 200,
		maxEmailSendsPerDay: 200,
		maxEmailReceivesPerDay: 1_000,
		maxStoredEmailMessages: 10_000,
		maxEmailMessageBytes: 768 * 1024,
		maxSecrets: 100,
		maxStorageBytes: 1024 * 1024 * 1024,
		maxConcurrentWorkflows: 10,
		// Public Standard execute is a try-paid rung with bursty daily
		// headroom and a weekly total. Continuous pre-cut subscribers keep
		// {@link legacyPlanLimits} (daily-only, no weekly window).
		maxExecuteCallsPerDay: 500,
		maxExecuteCallsPerWeek: 1_200,
		maxOutboundFetchesPerDay: 15_000,
		maxOutboundFetchesPerWeek: 40_000,
		maxJobRunsPerDay: 1_500,
		// Burst-friendly above job runs (1_500).
		maxAutomationInvocationsPerDay: 10_000,
		minJobIntervalMs: 15 * 60 * 1000,
		maxUniqueWorkerDaysPerMonth: 350,
		maxDurableObjectRowsReadPerMonth: 5_000_000_000,
	},
	pro: {
		maxRepos: 400,
		maxSavedPackages: 200,
		maxScheduledJobs: 75,
		maxRepoSessions: 400,
		maxEmailSendsPerDay: 500,
		maxEmailReceivesPerDay: 2_000,
		maxStoredEmailMessages: 25_000,
		maxEmailMessageBytes: 768 * 1024,
		maxSecrets: 200,
		maxStorageBytes: 5 * 1024 * 1024 * 1024,
		maxConcurrentWorkflows: 50,
		// Retired $49 Pro. Execute is a hard daily + weekly cap.
		maxExecuteCallsPerDay: 1_500,
		maxExecuteCallsPerWeek: 4_000,
		maxOutboundFetchesPerDay: 50_000,
		maxOutboundFetchesPerWeek: 120_000,
		maxJobRunsPerDay: 8_000,
		// Burst-friendly above job runs (8_000).
		maxAutomationInvocationsPerDay: 50_000,
		minJobIntervalMs: 5 * 60 * 1000,
		maxUniqueWorkerDaysPerMonth: 2_000,
		maxDurableObjectRowsReadPerMonth: 20_000_000_000,
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
		maxExecuteCallsPerWeek: null,
		// 2× pro (40_000). Today's fetch spike (~17,000) stays well under.
		maxOutboundFetchesPerDay: 80_000,
		maxOutboundFetchesPerWeek: null,
		// 2× the previous public Pro (20_000). Busy days are ~1,500–1,700
		// job runs. `max` ceilings stay on that earlier Pro table; they
		// still dominate every paid plan.
		maxJobRunsPerDay: 40_000,
		// Burst-friendly above job runs (40_000).
		maxAutomationInvocationsPerDay: 200_000,
		minJobIntervalMs: 0,
		maxUniqueWorkerDaysPerMonth: 25_000,
		// Dominates public Pro (20B). Operator cap only.
		maxDurableObjectRowsReadPerMonth: 200_000_000_000,
	},
}

/**
 * Pre-cut Standard/Pro ceilings. Applied only when
 * `users.entitlement_ladder = 'legacy'` and the effective plan is
 * `standard` or `pro`. Free and `max` always use {@link planLimits}.
 * Unique-worker-day and Durable Object rows-read includes match the
 * public table. Those allotments are not hard-cut and not charged for
 * legacy accounts (no credit wallet). Automation daily ceilings stay at
 * the earlier job-matched values (Standard 10_000, Pro 20_000).
 */
export const legacyPlanLimits: Record<'standard' | 'pro', PlanLimits> = {
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
		maxExecuteCallsPerDay: 500,
		maxExecuteCallsPerWeek: null,
		maxOutboundFetchesPerDay: 20_000,
		maxOutboundFetchesPerWeek: null,
		maxJobRunsPerDay: 10_000,
		maxAutomationInvocationsPerDay: 10_000,
		minJobIntervalMs: 0,
		maxUniqueWorkerDaysPerMonth: 350,
		maxDurableObjectRowsReadPerMonth: 5_000_000_000,
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
		maxExecuteCallsPerDay: 800,
		maxExecuteCallsPerWeek: null,
		maxOutboundFetchesPerDay: 40_000,
		maxOutboundFetchesPerWeek: null,
		maxJobRunsPerDay: 20_000,
		maxAutomationInvocationsPerDay: 20_000,
		minJobIntervalMs: 0,
		maxUniqueWorkerDaysPerMonth: 2_000,
		maxDurableObjectRowsReadPerMonth: 20_000_000_000,
	},
}

/**
 * Purchasable Pro ($12). Includes match the retired public Standard table
 * (350 unique worker days, 5B Durable Object rows read). Applied when the
 * effective plan is `pro` and the granting Stripe price is the configured
 * Pro price ({@link CreditWalletState} is not `none`).
 */
export const proCreditsPlanLimits: PlanLimits = { ...planLimits.standard }

/**
 * A funded wallet multiplies these rate/compute limits, capped at the `max`
 * operator ceilings (daily only: `max` has no weekly window). Email caps,
 * stock limits, storage, concurrency, and the job interval floor are
 * unchanged.
 */
export const creditsUnlockMultiplier = 50

export const creditsUnlockedLimitFields = [
	'maxExecuteCallsPerDay',
	'maxExecuteCallsPerWeek',
	'maxOutboundFetchesPerDay',
	'maxOutboundFetchesPerWeek',
	'maxJobRunsPerDay',
	'maxAutomationInvocationsPerDay',
] as const satisfies ReadonlyArray<keyof PlanLimits>

/** Entitlement resources whose limit a funded wallet raises. */
export const creditsUnlockedResources = [
	'execute_calls_per_day',
	'outbound_fetches_per_day',
	'job_runs_per_day',
	'automation_invocations_per_day',
] as const satisfies ReadonlyArray<EntitlementResource>

export function isCreditsUnlockedResource(
	resource: EntitlementResource,
): boolean {
	return (creditsUnlockedResources as ReadonlyArray<string>).includes(resource)
}

function unlockCreditsLimits(limits: PlanLimits): PlanLimits {
	const scale = (value: number, ceiling: number) =>
		Math.min(value * creditsUnlockMultiplier, ceiling)
	const scaleWeekly = (value: number | null) =>
		value === null ? null : value * creditsUnlockMultiplier
	const ceiling = planLimits.max
	return {
		...limits,
		maxExecuteCallsPerDay: scale(
			limits.maxExecuteCallsPerDay,
			ceiling.maxExecuteCallsPerDay,
		),
		maxExecuteCallsPerWeek: scaleWeekly(limits.maxExecuteCallsPerWeek),
		maxOutboundFetchesPerDay: scale(
			limits.maxOutboundFetchesPerDay,
			ceiling.maxOutboundFetchesPerDay,
		),
		maxOutboundFetchesPerWeek: scaleWeekly(limits.maxOutboundFetchesPerWeek),
		maxJobRunsPerDay: scale(limits.maxJobRunsPerDay, ceiling.maxJobRunsPerDay),
		maxAutomationInvocationsPerDay: scale(
			limits.maxAutomationInvocationsPerDay,
			ceiling.maxAutomationInvocationsPerDay,
		),
	} satisfies Record<(typeof creditsUnlockedLimitFields)[number], unknown> &
		PlanLimits
}

const proCreditsUnlockedPlanLimits = unlockCreditsLimits(proCreditsPlanLimits)

/**
 * Cloudflare list prices behind the credit debit rates (credits debit
 * about 2× list). Duration and CPU stay unmetered for customers.
 */
export const cloudflareComputeListUsd = {
	uniqueWorkerDay: 0.002,
	durableObjectRowsReadPerMillion: 0.001,
} as const

/**
 * Monthly compute meters: included usage is free on every plan. Above the
 * include, only a funded purchasable-Pro wallet is debited; nobody is
 * invoiced. Execute and outbound fetches are hard daily + weekly caps (a
 * funded wallet raises them).
 */
export const computeMeteringPolicy = {
	uniqueWorkerDays: 'included_then_credits',
	durableObjectRowsRead: 'included_then_credits',
	executeCallsPerDay: 'hard_daily_and_weekly_cap',
	outboundFetchesPerDay: 'hard_daily_and_weekly_cap',
	durableObjectDuration: 'unmetered',
	pastIncludeWithoutCredits: 'not_charged',
} as const

/** 15-minute floor on free (and public Standard) recurring jobs. */
export const freeMinJobIntervalMs = planLimits.free.minJobIntervalMs

/**
 * Resolve the full limit table for a plan. The purchasable Pro wallet
 * (`creditWallet` other than `none`) uses {@link proCreditsPlanLimits},
 * unlocked when funded. Legacy applies only to retired Standard/Pro; free
 * and `max` always use {@link planLimits}.
 */
export function resolvePlanLimits(
	plan: PlanName,
	ladder: EntitlementLadder = 'public',
	creditWallet: CreditWalletState = 'none',
): PlanLimits {
	if (plan === 'pro' && creditWallet !== 'none') {
		return creditWallet === 'funded'
			? proCreditsUnlockedPlanLimits
			: proCreditsPlanLimits
	}
	if (ladder === 'legacy' && (plan === 'standard' || plan === 'pro')) {
		return legacyPlanLimits[plan]
	}
	return planLimits[plan]
}

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

const billionDurableObjectRows = 1_000_000_000

/**
 * Compact label for monthly Durable Object rows-read includes (0.5B, 5B).
 */
export function formatDurableObjectRowsRead(rows: number): string {
	if (!Number.isFinite(rows) || rows < 0) return '0'
	const billions = rows / billionDurableObjectRows
	if (Number.isInteger(billions)) {
		return billions === 1 ? '1B' : `${billions}B`
	}
	return `${billions}B`
}

/**
 * Resolve the numeric limit for a resource under a plan. Every plan limit is
 * finite. Pass `legacy` for continuous pre-cut Standard/Pro subscribers.
 */
export function resolvePlanLimit(
	plan: PlanName,
	resource: EntitlementResource,
	ladder: EntitlementLadder = 'public',
	creditWallet: CreditWalletState = 'none',
): number {
	const limits = resolvePlanLimits(plan, ladder, creditWallet)
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
		case 'automation_invocations_per_day':
			return limits.maxAutomationInvocationsPerDay
		default: {
			const exhaustive: never = resource
			throw new Error(`Unknown entitlement resource: ${String(exhaustive)}`)
		}
	}
}

/** Daily resources that also have a public-ladder weekly hard cap. */
export const weeklyComputeWindowResources = [
	'execute_calls_per_day',
	'outbound_fetches_per_day',
] as const satisfies ReadonlyArray<EntitlementResource>

export type WeeklyComputeWindowResource =
	(typeof weeklyComputeWindowResources)[number]

export function isWeeklyComputeWindowResource(
	resource: EntitlementResource,
): resource is WeeklyComputeWindowResource {
	return (weeklyComputeWindowResources as ReadonlyArray<string>).includes(
		resource,
	)
}

/**
 * One-liner for pricing and /account usage next to execute / outbound
 * daily+weekly meters.
 */
export const weeklyComputeWindowNote =
	'High daily headroom for bursts; weekly total keeps it sustainable.'

/**
 * Weekly hard cap for execute or outbound on the public ladder.
 * Returns `null` when the plan/ladder has no weekly window (`max`,
 * legacy Standard/Pro, or any other resource).
 */
export function resolveWeeklyPlanLimit(
	plan: PlanName,
	resource: EntitlementResource,
	ladder: EntitlementLadder = 'public',
	creditWallet: CreditWalletState = 'none',
): number | null {
	if (!isWeeklyComputeWindowResource(resource)) return null
	const limits = resolvePlanLimits(plan, ladder, creditWallet)
	switch (resource) {
		case 'execute_calls_per_day':
			return limits.maxExecuteCallsPerWeek
		case 'outbound_fetches_per_day':
			return limits.maxOutboundFetchesPerWeek
		default: {
			const exhaustive: never = resource
			throw new Error(`Unknown weekly compute resource: ${String(exhaustive)}`)
		}
	}
}

/** Human label for a weekly execute/outbound denial. */
export function weeklyEntitlementResourceLabel(
	resource: WeeklyComputeWindowResource,
): string {
	switch (resource) {
		case 'execute_calls_per_day':
			return 'execute calls this week'
		case 'outbound_fetches_per_day':
			return 'outbound fetches this week'
		default: {
			const exhaustive: never = resource
			throw new Error(`Unknown weekly compute resource: ${String(exhaustive)}`)
		}
	}
}
