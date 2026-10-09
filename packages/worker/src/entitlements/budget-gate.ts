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

export { BudgetLimitError }
