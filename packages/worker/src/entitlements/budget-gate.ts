import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { type RequestSource } from '#worker/request-context/request-context.ts'
import { type TransactionalEmailEnv } from '#app/email/sender-config.ts'
import { sendBudgetHitEmail } from '#worker/billing/org-budget-hit-emails.ts'
import {
	readOrgBudgetSettings,
	readUserBudgetMicroUsd,
	resolveEffectiveUserBudgetMicroUsd,
} from '#worker/orgs/billing.ts'
import { BudgetLimitError, coerceBudgetLimitError } from './errors.ts'
import { type UserMeterEnv, userMeterRpc } from './user-meter-client.ts'

type OrgBudgetHitEmailEnv = Pick<
	Env,
	| 'BUNDLE_ARTIFACTS_KV'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
> &
	TransactionalEmailEnv

export type OrgBudgetGateContext = {
	orgId: string
	orgSlug?: string | null
	actorUserId?: string | null
	actorUsername?: string | null
	automationSource?: string | null
}

async function orgBudgetEnforcementAvailable(
	db: D1Database,
	orgId: string,
): Promise<boolean> {
	try {
		const row = await db
			.prepare(`SELECT 1 AS ok FROM orgs WHERE id = ? LIMIT 1`)
			.bind(orgId)
			.first<{ ok: number }>()
		return row != null
	} catch {
		return false
	}
}

async function loadBudgetLimits(input: {
	db: D1Database
	orgId: string
	actorUserId: string | null
}): Promise<{
	userBudgetMicroUsd: number | null
	automationBudgetMicroUsd: number | null
}> {
	try {
		const settings = await readOrgBudgetSettings(input.db, input.orgId)
		const individual =
			input.actorUserId == null
				? null
				: await readUserBudgetMicroUsd(input.db, input.orgId, input.actorUserId)
		return {
			userBudgetMicroUsd: resolveEffectiveUserBudgetMicroUsd({
				individualBudget: individual,
				orgDefaultBudget: settings.defaultUserBudgetMicroUsd,
			}),
			automationBudgetMicroUsd: settings.automationBudgetMicroUsd,
		}
	} catch {
		return {
			userBudgetMicroUsd: null,
			automationBudgetMicroUsd: null,
		}
	}
}

function orgSlugLabel(orgSlug: string | null | undefined) {
	const trimmed = orgSlug?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : 'org'
}

/**
 * Real-time org budget gate backed by the org-scoped UserMeter durable object
 * (name key is org id; personal org ids match the owner user id).
 */
function notifyBudgetHitFireAndForget(input: {
	env: UserMeterEnv & OrgBudgetHitEmailEnv
	db: D1Database
	orgId: string
	actorUserId: string | null
	budgetError: BudgetLimitError
	now?: Date
}) {
	void sendBudgetHitEmail({
		env: input.env,
		db: input.db,
		orgId: input.orgId,
		details: input.budgetError.details,
		actorUserId: input.actorUserId,
		now: input.now,
	}).catch((error: unknown) => {
		console.warn('org-budget-hit-email-failed', error)
	})
}

export async function assertWithinOrgBudget(input: {
	db: D1Database
	env: UserMeterEnv
	orgId: string
	orgSlug?: string | null
	actorUserId: string | null
	automationSource: string | null
	actorUsername?: string | null
	estimatedDeltaMicroUsd: number
	now?: Date
}): Promise<void> {
	if (!(await orgBudgetEnforcementAvailable(input.db, input.orgId))) {
		return
	}
	const actorUserId = input.actorUserId
	const isAutomation = actorUserId == null && input.automationSource != null
	const limits = await loadBudgetLimits({
		db: input.db,
		orgId: input.orgId,
		actorUserId: isAutomation ? null : actorUserId,
	})
	const userBudget = isAutomation ? null : limits.userBudgetMicroUsd
	const automationBudget = isAutomation ? limits.automationBudgetMicroUsd : null
	if (userBudget == null && automationBudget == null) {
		return
	}
	const month = utcMonthKey(input.now ?? new Date())
	const meter = userMeterRpc({ env: input.env, userId: input.orgId })
	try {
		await meter.assertWithinBudgetAndRecord({
			month,
			actorUserId: isAutomation ? null : actorUserId,
			automationSource: input.automationSource,
			deltaMicroUsd: input.estimatedDeltaMicroUsd,
			userBudgetMicroUsd: userBudget,
			automationBudgetMicroUsd: automationBudget,
			actorUsername: input.actorUsername,
			orgSlug: orgSlugLabel(input.orgSlug),
		})
	} catch (error) {
		const budgetError = coerceBudgetLimitError(error)
		if (budgetError) {
			notifyBudgetHitFireAndForget({
				env: input.env as UserMeterEnv & OrgBudgetHitEmailEnv,
				db: input.db,
				orgId: input.orgId,
				actorUserId: isAutomation ? null : actorUserId,
				budgetError,
				now: input.now,
			})
			throw budgetError
		}
		throw error
	}
}

/** Whether MTD budget counters should move for this UTC month (live gate month only). */
export function shouldMutateBudgetMtdForMonth(
	month: string,
	now: Date,
): boolean {
	const current = utcMonthKey(now)
	return month === current
}

/** Map scheduled/automation job runs to org budget gate context. */
export function orgBudgetForJobExecution(input: {
	orgId: string
	orgSlug: string | null
	source: RequestSource
}): OrgBudgetGateContext {
	if (input.source.kind === 'inherited') {
		const actor = input.source.lineage.actor
		if (actor?.userId) {
			return {
				orgId: input.orgId,
				orgSlug: input.orgSlug,
				actorUserId: actor.userId,
				actorUsername: actor.username ?? null,
			}
		}
	}
	const automationSource =
		input.source.kind === 'schedule'
			? 'schedule'
			: input.source.kind === 'webhook'
				? 'webhook'
				: input.source.kind === 'inbound-email'
					? 'email'
					: input.source.kind === 'platform-event'
						? 'event'
						: 'schedule'
	return {
		orgId: input.orgId,
		orgSlug: input.orgSlug,
		automationSource,
		actorUserId: null,
	}
}

/** Record metered spend without re-checking limits (ledger reconciliation). */
export async function recordOrgBudgetSpend(input: {
	db: D1Database
	env: UserMeterEnv
	orgId: string
	orgSlug?: string | null
	actorUserId: string | null
	automationSource: string | null
	deltaMicroUsd: number
	now?: Date
	/** Defaults to the UTC month of `now`; past months skip MTD mutation. */
	month?: string
}): Promise<void> {
	const delta = Math.max(0, Math.floor(Number(input.deltaMicroUsd)))
	if (delta === 0) return
	if (!(await orgBudgetEnforcementAvailable(input.db, input.orgId))) {
		return
	}
	const now = input.now ?? new Date()
	const month = input.month ?? utcMonthKey(now)
	if (!shouldMutateBudgetMtdForMonth(month, now)) {
		console.info('org_budget_spend_skip_past_month', {
			orgId: input.orgId,
			month,
			currentMonth: utcMonthKey(now),
		})
		return
	}
	const actorUserId = input.actorUserId
	const isAutomation = actorUserId == null && input.automationSource != null
	const meter = userMeterRpc({ env: input.env, userId: input.orgId })
	try {
		await meter.assertWithinBudgetAndRecord({
			month,
			actorUserId: isAutomation ? null : actorUserId,
			automationSource: input.automationSource,
			deltaMicroUsd: delta,
			userBudgetMicroUsd: null,
			automationBudgetMicroUsd: null,
			orgSlug: orgSlugLabel(input.orgSlug),
		})
	} catch (error) {
		const budgetError = coerceBudgetLimitError(error)
		if (budgetError) throw budgetError
		throw error
	}
}

export function orgBudgetFromGateContext(
	userId: string,
	context?: OrgBudgetGateContext | null,
): Required<
	Pick<
		OrgBudgetGateContext,
		'orgId' | 'orgSlug' | 'actorUserId' | 'actorUsername' | 'automationSource'
	>
> {
	return {
		orgId: context?.orgId ?? userId,
		orgSlug: context?.orgSlug ?? null,
		actorUserId: context?.automationSource
			? null
			: (context?.actorUserId ?? userId),
		actorUsername: context?.actorUsername ?? null,
		automationSource: context?.automationSource ?? null,
	}
}

type AttributionSpendShare = {
	actorUserId: string | null
	automationSource: string | null
	weight: number
}

/**
 * After a funded credit debit, attribute the spent micro-USD into org budget
 * MTD counters. The real-time gate only checks (delta 0); settlement is what
 * advances spend so member/automation budgets can block later work.
 *
 * Splits by `usage_attribution_daily` actor weights for the month when present;
 * otherwise attributes the debit to the org billing id as the member actor
 * (personal-org soak: org id equals the owner user id).
 */
export async function recordOrgBudgetSpendAfterCreditDebit(input: {
	db: D1Database
	env: UserMeterEnv
	orgId: string
	month: string
	debitedMicroUsd: number
	now?: Date
}): Promise<void> {
	const debit = Math.max(0, Math.floor(Number(input.debitedMicroUsd)))
	if (debit === 0) return
	const now = input.now ?? new Date()
	if (!shouldMutateBudgetMtdForMonth(input.month, now)) {
		return
	}
	const shares = await loadBudgetSpendShares({
		db: input.db,
		orgId: input.orgId,
		month: input.month,
	})
	const totalWeight = shares.reduce((sum, share) => sum + share.weight, 0)
	if (totalWeight <= 0 || shares.length === 0) {
		await recordOrgBudgetSpend({
			db: input.db,
			env: input.env,
			orgId: input.orgId,
			actorUserId: input.orgId,
			automationSource: null,
			deltaMicroUsd: debit,
			now,
			month: input.month,
		})
		return
	}
	let allocated = 0
	for (let index = 0; index < shares.length; index += 1) {
		const share = shares[index]!
		const isLast = index === shares.length - 1
		const slice = isLast
			? debit - allocated
			: Math.floor((debit * share.weight) / totalWeight)
		allocated += slice
		if (slice <= 0) continue
		await recordOrgBudgetSpend({
			db: input.db,
			env: input.env,
			orgId: input.orgId,
			actorUserId: share.actorUserId,
			automationSource: share.automationSource,
			deltaMicroUsd: slice,
			now,
			month: input.month,
		})
	}
}

async function loadBudgetSpendShares(input: {
	db: D1Database
	orgId: string
	month: string
}): Promise<Array<AttributionSpendShare>> {
	const monthPrefix = `${input.month}-`
	try {
		const { results } = await input.db
			.prepare(
				`SELECT
					COALESCE(actor_user_id, '') AS actor_user_id,
					COALESCE(automation_source, '') AS automation_source,
					SUM(units) AS weight
				 FROM usage_attribution_daily
				 WHERE user_id = ?
				   AND day >= ?
				   AND day < ?
				   AND meter IN ('dynamic_worker_day', 'durable_object_rows_read')
				 GROUP BY COALESCE(actor_user_id, ''), COALESCE(automation_source, '')`,
			)
			.bind(
				input.orgId,
				`${monthPrefix}01`,
				// Exclusive upper bound: first day of next month (month is YYYY-MM).
				nextUtcMonthDay(input.month),
			)
			.all<{
				actor_user_id: string
				automation_source: string
				weight: number
			}>()
		const shares: Array<AttributionSpendShare> = []
		for (const row of results ?? []) {
			const weight = Number(row.weight)
			if (!Number.isFinite(weight) || weight <= 0) continue
			const actor = row.actor_user_id.trim()
			const automation = row.automation_source.trim()
			if (actor.length > 0) {
				shares.push({
					actorUserId: actor,
					automationSource: null,
					weight,
				})
				continue
			}
			if (automation.length > 0) {
				shares.push({
					actorUserId: null,
					automationSource: automation,
					weight,
				})
			}
		}
		return shares
	} catch {
		return []
	}
}

function nextUtcMonthDay(month: string): string {
	const [yearText, monthText] = month.split('-')
	const year = Number(yearText)
	const monthIndex = Number(monthText)
	if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) {
		return `${month}-32`
	}
	if (monthIndex >= 12) {
		return `${year + 1}-01-01`
	}
	return `${year}-${String(monthIndex + 1).padStart(2, '0')}-01`
}

export { BudgetLimitError }
