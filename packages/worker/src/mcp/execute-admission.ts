import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestCredential } from '@kody-internal/shared/request-context.ts'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { utcDayKey, utcWeekStart } from '@kody-internal/shared/date-keys.ts'
import {
	sendEntitlementWarningNow,
	userEntitlementApproachingThreshold,
	type UserEntitlementWarningKind,
} from '#worker/entitlements/user-entitlement-warning-emails.ts'
import { entitlementResourceLabels } from '#universal/plans.ts'
import { type OrgBudgetGateContext } from '#worker/entitlements/budget-gate.ts'
import {
	consumeExecuteUniqueWorkerDay,
	type ExecuteUniqueWorkerUsage,
} from '#worker/entitlements/service.ts'
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

/**
 * Identical execute calls (same code or invoke target and same params) one
 * connection may start per window before the loop brake refuses. Polling a
 * status every 3 seconds stays under it; a back-to-back retry loop (each
 * call returns in a second or two) trips it within the first minute. The
 * brake only covers calls that cannot differ, so any change to code or
 * params runs normally.
 */
export const identicalExecuteCallsPerWindow = 20
export const identicalExecuteCallWindowMs = 60_000

export const executeLoopDetectedErrorCode = 'execute_loop_detected' as const

export class ExecuteLoopDetectedError extends Error {
	readonly code = executeLoopDetectedErrorCode
	readonly retryAfterMs: number

	constructor(input: { repeats: number; retryAfterMs: number }) {
		const seconds = Math.max(1, Math.ceil(input.retryAfterMs / 1000))
		const windowSeconds = identicalExecuteCallWindowMs / 1000
		super(
			`Execute loop detected: this connection ran the same code with the same params ${input.repeats} times in the last ${windowSeconds}s. You are probably looping. Stop and read the last result before retrying, or change the code or params. The same call is refused for ${seconds}s.`,
		)
		this.name = 'ExecuteLoopDetectedError'
		this.retryAfterMs = input.retryAfterMs
	}
}

/**
 * Repeat key for the loop brake: the connection (credential, acting user,
 * and the caller's conversation id when it sent one) plus the exact code or
 * invoke target and canonical params.
 */
export async function executeRepeatKey(input: {
	credential: Pick<RequestCredential, 'kind' | 'id'> | null
	actorUserId: string | null
	conversationId: string | undefined
	code: string | undefined
	invoke: string | undefined
	params: Record<string, unknown> | undefined
}): Promise<string> {
	return await sha256Base64Url(
		canonicalJsonStringify({
			credentialKind: input.credential?.kind ?? null,
			credentialId: input.credential?.id ?? null,
			actorUserId: input.actorUserId,
			conversationId: input.conversationId ?? null,
			code: input.code ?? null,
			invoke: input.invoke ?? null,
			params: input.params ?? null,
		}),
	)
}

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

/** Machine-readable brake refusal for the execute tool's structured error. */
export function executeAdmissionStructuredContent(error: unknown) {
	if (
		error instanceof ExecuteRateLimitedError ||
		error instanceof ExecuteLoopDetectedError
	) {
		return {
			admission: { code: error.code, retryAfterMs: error.retryAfterMs },
		}
	}
	return {}
}

/** Refuses the call before any claim, bundle, or sandbox work. */
export async function admitHostedExecuteCall(input: {
	env: Env
	ownerId: OwnerId
	repeatKey?: string
	now?: Date
}): Promise<void> {
	const admission = await userMeterRpc({
		env: input.env,
		userId: input.ownerId,
	}).admitExecuteCall({
		nowMs: (input.now ?? new Date()).getTime(),
		limitPerMinute: executeCallsPerMinutePerOrg,
		...(input.repeatKey
			? {
					repeat: {
						key: input.repeatKey,
						limit: identicalExecuteCallsPerWindow,
						windowMs: identicalExecuteCallWindowMs,
					},
				}
			: {}),
	})
	if (admission.admitted) return
	switch (admission.reason) {
		case 'rate':
			throw new ExecuteRateLimitedError({
				limitPerMinute: executeCallsPerMinutePerOrg,
				retryAfterMs: admission.retryAfterMs,
			})
		case 'repeat':
			throw new ExecuteLoopDetectedError({
				repeats: admission.repeats,
				retryAfterMs: admission.retryAfterMs,
			})
		default: {
			const exhaustive: never = admission
			throw new Error(`Unknown execute admission: ${String(exhaustive)}`)
		}
	}
}

/**
 * Capped claim for the top-level hosted execute worker: one
 * `execute_unique_workers_per_day` unit per new worker per UTC day, and the
 * matching `dynamic_worker_day` usage event. Reports the counts after every
 * claim (repeats included) through `onUsage`, and mails the 80% / 100%
 * warning from the claim that crosses it.
 */
export function createExecuteWorkerDayClaim(input: {
	env: Env
	ownerId: OwnerId
	email: string | null | undefined
	orgBudget?: OrgBudgetGateContext
	onUsage?: (claimed: ClaimedExecuteUsage) => void
	waitUntil?: (promise: Promise<unknown>) => void
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
		input.onUsage?.({ usage, claimedAt: now })
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
			const crossing = executeDailyWarningCrossing(usage)
			if (crossing) {
				const send = sendEntitlementWarningNow({
					env: input.env,
					ownerId: input.ownerId,
					kind: crossing,
					warning: {
						resource: executeUsageResource,
						label: entitlementResourceLabels[executeUsageResource],
						current: usage.used,
						limit: usage.limit,
						percentOfLimit: usage.used / usage.limit,
					},
					now,
				}).catch((error: unknown) => {
					console.warn('execute-entitlement-warning-send-failed', error)
				})
				if (input.waitUntil) input.waitUntil(send)
				else void send
			}
		}
		return { created: usage.created }
	}
}

const executeUsageResource = 'execute_unique_workers_per_day' as const

/**
 * The claim that lands exactly on 80% or 100% of the daily limit is the
 * crossing: the counter only moves one unit per new worker, so each window
 * crosses each threshold on exactly one call.
 */
export function executeDailyWarningCrossing(
	usage: Pick<ExecuteUniqueWorkerUsage, 'used' | 'limit'>,
): UserEntitlementWarningKind | null {
	if (usage.limit <= 0) return null
	if (usage.used === usage.limit) return 'reached'
	if (
		usage.used === Math.ceil(usage.limit * userEntitlementApproachingThreshold)
	) {
		return 'approaching'
	}
	return null
}

export type ClaimedExecuteUsage = {
	usage: ExecuteUniqueWorkerUsage
	claimedAt: Date
}

/**
 * The claim's counts while they still describe the current window. A run
 * that crosses UTC midnight (or a Monday) would pair yesterday's counts with
 * tomorrow's reset, so the caller re-reads instead.
 */
export function claimedUsageForNow(
	claimed: ClaimedExecuteUsage | null,
	now: Date,
): ExecuteUniqueWorkerUsage | null {
	if (!claimed) return null
	return utcDayKey(claimed.claimedAt) === utcDayKey(now) ? claimed.usage : null
}

export type ExecuteUsageWindow = {
	used: number
	limit: number
	remaining: number
	resetsAt: string
}

export type ExecuteUsageReport = {
	unit: string
	day: ExecuteUsageWindow
	week?: ExecuteUsageWindow
}

const dayMs = 24 * 60 * 60 * 1000

/** Remaining hosted execute allowance for every execute response. */
export function buildExecuteUsageReport(
	usage: ExecuteUniqueWorkerUsage,
	now: Date,
): ExecuteUsageReport {
	const window = (used: number, limit: number, resetsAtMs: number) => ({
		used,
		limit,
		remaining: Math.max(0, limit - used),
		resetsAt: new Date(resetsAtMs).toISOString(),
	})
	const nextDayMs = Date.parse(`${utcDayKey(now)}T00:00:00.000Z`) + dayMs
	const nextWeekMs =
		Date.parse(`${utcWeekStart(now)}T00:00:00.000Z`) + 7 * dayMs
	return {
		unit: entitlementResourceLabels[executeUsageResource].replace(
			/ per day$/,
			'',
		),
		day: window(usage.used, usage.limit, nextDayMs),
		...(usage.weekLimit !== null
			? { week: window(usage.weekUsed ?? 0, usage.weekLimit, nextWeekMs) }
			: {}),
	}
}
