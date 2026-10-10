import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgBudgetGateContext } from '#worker/entitlements/budget-gate.ts'
import { consumeExecuteUniqueWorkerDay } from '#worker/entitlements/service.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { type ClaimWorkerDay } from './executor.ts'

/**
 * Hosted execute calls one org may start per minute, counting every call
 * (repeats, failures, warm workers). A runaway safety net, not a plan
 * limit: production's busiest org-minute over the 30 days to 2026-10-10
 * was 64 calls, so 300 (about 5×, 5 calls per second sustained) never
 * touches real work while still bounding a fan-out storm that only hits
 * warm workers and so never reaches the unique-worker cap.
 */
export const executeCallsPerMinutePerOrg = 300

export const executeRateLimitedErrorCode = 'execute_rate_limited' as const

export class ExecuteRateLimitedError extends Error {
	readonly code = executeRateLimitedErrorCode
	readonly retryAfterMs: number

	constructor(input: { limitPerMinute: number; retryAfterMs: number }) {
		const seconds = Math.max(1, Math.ceil(input.retryAfterMs / 1000))
		super(
			`Execute rate limit: this account started ${input.limitPerMinute} execute calls in the last minute, the runaway safety limit. Wait ${seconds}s before retrying, and check for an agent loop or unbounded fan-out.`,
		)
		this.name = 'ExecuteRateLimitedError'
		this.retryAfterMs = input.retryAfterMs
	}
}

/** Refuses the call before any claim, bundle, or sandbox work. */
export async function admitHostedExecuteCall(input: {
	env: Env
	ownerId: OwnerId
	now?: Date
}): Promise<void> {
	const admission = await userMeterRpc({
		env: input.env,
		userId: input.ownerId,
	}).admitExecuteCall({
		nowMs: (input.now ?? new Date()).getTime(),
		limitPerMinute: executeCallsPerMinutePerOrg,
	})
	if (!admission.admitted) {
		throw new ExecuteRateLimitedError({
			limitPerMinute: executeCallsPerMinutePerOrg,
			retryAfterMs: admission.retryAfterMs,
		})
	}
}

/**
 * Capped claim for the top-level hosted execute worker: one
 * `execute_unique_workers_per_day` unit per new worker per UTC day, and the
 * matching `dynamic_worker_day` usage event.
 */
export function createExecuteWorkerDayClaim(input: {
	env: Env
	ownerId: OwnerId
	email: string | null | undefined
	orgBudget?: OrgBudgetGateContext
}): ClaimWorkerDay {
	return async (workerId, attribution) => {
		const now = new Date()
		const usage = await consumeExecuteUniqueWorkerDay({
			db: input.env.APP_DB,
			env: input.env,
			userId: input.ownerId,
			email: input.email,
			workerId,
			now,
			orgBudget: input.orgBudget,
		})
		if (usage.created) {
			await recordUsage(input.env, {
				userId: input.ownerId,
				eventType: 'dynamic_worker_day',
				entityId: workerId,
				outcome: 'success',
				timestamp: now.toISOString(),
				surface: 'execute',
				...attribution,
			})
		}
		return { created: usage.created }
	}
}
