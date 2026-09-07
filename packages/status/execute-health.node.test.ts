import { expect, test } from 'vitest'
import {
	applyExecuteHealthTick,
	claimExecuteHealthSynthetic,
	countExecuteHealthSynthetics,
	decideExecuteHealthProbe,
	deriveExecuteHealthView,
	executeHealthOrganicFreshMs,
	executeHealthSyntheticCooldownMs,
} from './execute-health.ts'

const hourMs = executeHealthSyntheticCooldownMs
const minuteMs = executeHealthOrganicFreshMs
const start = Date.parse('2026-09-07T17:00:00.000Z')

function ticks(count: number, stepMs = minuteMs) {
	return Array.from({ length: count }, (_, index) => start + index * stepMs)
}

test('fresh organic success suppresses the synthetic and stale organic triggers once', () => {
	expect(
		decideExecuteHealthProbe({
			now: start + 15_000,
			lastSuccessAt: start,
			lastSyntheticAttemptAt: null,
		}),
	).toBe('skip')
	expect(
		decideExecuteHealthProbe({
			now: start + minuteMs,
			lastSuccessAt: start,
			lastSyntheticAttemptAt: null,
		}),
	).toBe('run')
	expect(
		claimExecuteHealthSynthetic({
			now: start + minuteMs,
			lastSuccessAt: start,
			lastSyntheticAttemptAt: null,
		}),
	).toEqual({
		run: true,
		lastSyntheticAttemptAt: start + minuteMs,
	})
})

test('no traffic across many minute ticks stays at most once per hour, and success and failure both obey cooldown', () => {
	expect(
		countExecuteHealthSynthetics({
			ticks: ticks(59),
			lastSuccessAt: null,
		}),
	).toBe(1)
	expect(
		countExecuteHealthSynthetics({
			ticks: ticks(180),
			lastSuccessAt: null,
		}),
	).toBe(3)
	expect(
		countExecuteHealthSynthetics({
			ticks: ticks(61),
			lastSuccessAt: null,
		}),
	).toBe(2)

	const afterSuccess = claimExecuteHealthSynthetic({
		now: start,
		lastSuccessAt: null,
		lastSyntheticAttemptAt: null,
	})
	expect(afterSuccess.run).toBe(true)
	expect(
		decideExecuteHealthProbe({
			now: start + minuteMs,
			lastSuccessAt: start,
			lastSyntheticAttemptAt: afterSuccess.lastSyntheticAttemptAt,
		}),
	).toBe('skip')
	expect(
		decideExecuteHealthProbe({
			now: start + 30_000,
			lastSuccessAt: null,
			lastSyntheticAttemptAt: afterSuccess.lastSyntheticAttemptAt,
		}),
	).toBe('skip')

	const afterFailure = claimExecuteHealthSynthetic({
		now: start,
		lastSuccessAt: null,
		lastSyntheticAttemptAt: null,
	})
	expect(
		decideExecuteHealthProbe({
			now: start + hourMs - 1,
			lastSuccessAt: null,
			lastSyntheticAttemptAt: afterFailure.lastSyntheticAttemptAt,
		}),
	).toBe('skip')
	expect(
		decideExecuteHealthProbe({
			now: start + hourMs,
			lastSuccessAt: null,
			lastSyntheticAttemptAt: afterFailure.lastSyntheticAttemptAt,
		}),
	).toBe('run')
})

test('concurrent ticks cannot duplicate a synthetic', () => {
	const first = claimExecuteHealthSynthetic({
		now: start,
		lastSuccessAt: null,
		lastSyntheticAttemptAt: null,
	})
	const second = claimExecuteHealthSynthetic({
		now: start,
		lastSuccessAt: null,
		lastSyntheticAttemptAt: first.lastSyntheticAttemptAt,
	})
	expect(first.run).toBe(true)
	expect(second.run).toBe(false)
	expect(second.lastSyntheticAttemptAt).toBe(start)
})

test('stale or missing telemetry is unknown, not an outage or a fresh healthy signal', () => {
	const missing = deriveExecuteHealthView({
		now: start,
		lastSuccessAt: null,
		lastSyntheticAttemptAt: null,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: null,
		syntheticConfigured: true,
	})
	expect(missing.status).toBe('unknown')
	expect(missing.source).toBeNull()
	expect(missing.lastVerifiedAt).toBeNull()
	expect(missing.detail).toMatch(/not recently exercised/i)
	expect(missing.detail).toMatch(/not an outage/i)
	expect(missing.detail).not.toMatch(/operational|down|outage confirmed/i)

	const stale = deriveExecuteHealthView({
		now: start + 10 * minuteMs,
		lastSuccessAt: start,
		lastSyntheticAttemptAt: null,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: null,
		syntheticConfigured: true,
	})
	expect(stale.status).toBe('unknown')
	expect(stale.source).toBe('organic')
	expect(stale.lastVerifiedAt).toBe(new Date(start).toISOString())
	expect(stale.freshnessMs).toBe(10 * minuteMs)
	expect(stale.detail).toMatch(/not recently exercised/i)
})

test('caller failures are not automatically a global outage, and one organic success does not hide other incidents', () => {
	const failedSynthetic = deriveExecuteHealthView({
		now: start + minuteMs,
		lastSuccessAt: null,
		lastSyntheticAttemptAt: start,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: 'MCP execute returned isError',
		syntheticConfigured: true,
	})
	expect(failedSynthetic.status).toBe('unknown')
	expect(failedSynthetic.detail).toMatch(/not an outage/i)
	expect(failedSynthetic.detail).toMatch(/caller-code errors/i)

	const organic = deriveExecuteHealthView({
		now: start + 5_000,
		lastSuccessAt: start,
		lastSyntheticAttemptAt: null,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: null,
		syntheticConfigured: true,
	})
	expect(organic.status).toBe('recent')
	expect(organic.source).toBe('organic')
	expect(organic.lastVerifiedAt).toBe(new Date(start).toISOString())
	expect(organic.detail).toMatch(/organic/i)
})

test('public reads do not run a synthetic; only a claimed tick can', async () => {
	const runSynthetic = async () => {
		throw new Error('public status GET must not run a paid execute')
	}
	const skipped = await applyExecuteHealthTick({
		now: start + 15_000,
		lastSuccessAt: start,
		lastSyntheticAttemptAt: null,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: null,
		syntheticConfigured: true,
		runSynthetic,
	})
	expect(skipped.lastSyntheticAttemptAt).toBeNull()

	let runs = 0
	const ran = await applyExecuteHealthTick({
		now: start + minuteMs,
		lastSuccessAt: start,
		lastSyntheticAttemptAt: null,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: null,
		syntheticConfigured: true,
		runSynthetic: async () => {
			runs += 1
			return { ok: false, error: 'timeout' }
		},
	})
	expect(runs).toBe(1)
	expect(ran.lastSyntheticAttemptAt).toBe(start + minuteMs)
	expect(ran.lastSyntheticError).toBe('timeout')
	expect(ran.lastSyntheticSuccessAt).toBeNull()
})
