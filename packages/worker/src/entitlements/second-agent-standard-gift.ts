/**
 * Durable one-gift-per-user Standard overlay. Triggered when known connected
 * agent ecosystems first reach 2. Callers pass that count; this module does
 * not recount grants.
 */

import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { hasSecondAgentEcosystem } from '#universal/onboarding-agent-ecosystems.ts'
import { parseStoredPlanName } from '#universal/plans.ts'
import {
	describeSecondAgentStandardGift,
	resolveSecondAgentStandardGiftWrite,
	type SecondAgentStandardGiftState,
} from '#universal/second-agent-standard-gift.ts'

export type SecondAgentStandardGiftEvaluation =
	| { outcome: 'below_threshold' }
	| { outcome: 'no_user' }
	| {
			outcome: 'already_granted'
			gift: SecondAgentStandardGiftState
	  }
	| {
			outcome: 'granted'
			gift: SecondAgentStandardGiftState
	  }

type GiftUserRow = {
	plan: string
	stripe_plan: string | null
	second_agent_standard_gift_granted_at: string | null
	second_agent_standard_gift_expires_at: string | null
}

/**
 * Safe evaluator for authorize completion and grant-list pages. Missing
 * `prepare` skips both write and read. A failed listing or an ecosystem
 * count below 2 skips the write but still returns the persisted ledger so
 * `/onboarding.json` does not hide an already-granted gift.
 */
export async function maybeEvaluateSecondAgentStandardGift(input: {
	db?: D1Database
	stableUserId: string
	ecosystemCount: number
	listingFailed?: boolean
	now?: Date
}): Promise<SecondAgentStandardGiftState> {
	if (typeof input.db?.prepare !== 'function') {
		return describeSecondAgentStandardGift({})
	}
	try {
		if (!input.listingFailed && hasSecondAgentEcosystem(input.ecosystemCount)) {
			await evaluateSecondAgentStandardGift({
				db: input.db,
				stableUserId: input.stableUserId,
				ecosystemCount: input.ecosystemCount,
				now: input.now,
			})
		}
		return await loadSecondAgentStandardGift(
			input.db,
			input.stableUserId,
			input.now,
		)
	} catch (error) {
		console.warn('second-agent-standard-gift-evaluate-failed', error)
		return describeSecondAgentStandardGift({})
	}
}

export async function loadSecondAgentStandardGift(
	db: D1Database,
	stableUserId: string,
	now: Date = new Date(),
): Promise<SecondAgentStandardGiftState> {
	const row = await db
		.prepare(
			`SELECT second_agent_standard_gift_granted_at,
			        second_agent_standard_gift_expires_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(stableUserId)
		.first<{
			second_agent_standard_gift_granted_at: string | null
			second_agent_standard_gift_expires_at: string | null
		}>()
	return describeSecondAgentStandardGift({
		grantedAt: row?.second_agent_standard_gift_granted_at,
		expiresAt: row?.second_agent_standard_gift_expires_at,
		now,
	})
}

/**
 * Record the one gift when known ecosystems first reach 2.
 * Idempotent: a second event returns the existing row and does not rewrite
 * expires_at or Stripe.
 */
export async function evaluateSecondAgentStandardGift(input: {
	db: D1Database
	stableUserId: string
	ecosystemCount: number
	now?: Date
}): Promise<SecondAgentStandardGiftEvaluation> {
	if (!hasSecondAgentEcosystem(input.ecosystemCount)) {
		return { outcome: 'below_threshold' }
	}
	const now = input.now ?? new Date()
	const row = await input.db
		.prepare(
			`SELECT plan, stripe_plan,
			        second_agent_standard_gift_granted_at,
			        second_agent_standard_gift_expires_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(input.stableUserId)
		.first<GiftUserRow>()
	if (!row) return { outcome: 'no_user' }

	if (row.second_agent_standard_gift_granted_at) {
		return {
			outcome: 'already_granted',
			gift: describeSecondAgentStandardGift({
				grantedAt: row.second_agent_standard_gift_granted_at,
				expiresAt: row.second_agent_standard_gift_expires_at,
				now,
			}),
		}
	}

	const write = resolveSecondAgentStandardGiftWrite({
		manualPlan: parseStoredPlanName(row.plan),
		stripePlan: row.stripe_plan,
		now,
	})
	const grantedAt = now.toISOString()
	const updated = await input.db
		.prepare(
			`UPDATE users
			 SET second_agent_standard_gift_granted_at = ?,
			     second_agent_standard_gift_expires_at = ?,
			     updated_at = ?
			 WHERE stable_user_id = ?
			   AND second_agent_standard_gift_granted_at IS NULL`,
		)
		.bind(
			grantedAt,
			write.expiresAt,
			utcSqliteTimestamp(now),
			input.stableUserId,
		)
		.run()

	if ((updated.meta.changes ?? 0) === 0) {
		return {
			outcome: 'already_granted',
			gift: await loadSecondAgentStandardGift(
				input.db,
				input.stableUserId,
				now,
			),
		}
	}

	return {
		outcome: 'granted',
		gift: describeSecondAgentStandardGift({
			grantedAt,
			expiresAt: write.expiresAt,
			now,
		}),
	}
}
