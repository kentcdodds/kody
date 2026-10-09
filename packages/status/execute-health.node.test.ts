import { expect, test } from 'vitest'
import {
	applyExecuteHealthTick,
	claimExecuteHealthSynthetic,
	countExecuteHealthSynthetics,
	decideExecuteHealthProbe,
	deriveExecuteHealthView,
	executeHealthOrganicFreshMs,
	executeHealthRecentMs,
	executeHealthSyntheticCooldownMs,
	mergeExecuteLastSuccess,
	readExecuteHealthSyntheticResult,
	resolvePublicExecuteLastSuccess,
	shouldRefreshExecuteLastSuccess,
} from './execute-health.ts'

const hourMs = executeHealthSyntheticCooldownMs
const recentMs = executeHealthRecentMs
const minuteMs = executeHealthOrganicFreshMs
const start = Date.parse('2026-09-07T17:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

function ticks(count: number, stepMs = minuteMs) {
	return Array.from({ length: count }, (_, index) => start + index * stepMs)
}

type ViewInput = Parameters<typeof deriveExecuteHealthView>[0]
const view = (now: number, overrides: Partial<ViewInput> = {}) =>
	deriveExecuteHealthView({
		now,
		lastSuccessAt: null,
		lastSyntheticAttemptAt: null,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: null,
		syntheticConfigured: true,
		...overrides,
	})
const idleTick = {
	lastSuccessAt: null,
	lastSyntheticAttemptAt: null,
	lastSyntheticSuccessAt: null,
	lastSyntheticError: null,
	syntheticConfigured: true,
}

test('synthetic probe runs on stale organic, once per hourly cooldown after success or failure, and never twice concurrently', () => {
	const claimed = claimExecuteHealthSynthetic({
		now: start,
		lastSuccessAt: null,
		lastSyntheticAttemptAt: null,
	})
	expect(claimed).toEqual({ run: true, lastSyntheticAttemptAt: start })
	const concurrent = claimExecuteHealthSynthetic({
		now: start,
		lastSuccessAt: null,
		lastSyntheticAttemptAt: claimed.lastSyntheticAttemptAt,
	})
	expect(concurrent).toEqual({ run: false, lastSyntheticAttemptAt: start })
	expect(
		claimExecuteHealthSynthetic({
			now: start + minuteMs,
			lastSuccessAt: start,
			lastSyntheticAttemptAt: null,
		}),
	).toEqual({ run: true, lastSyntheticAttemptAt: start + minuteMs })

	// [now, lastSuccessAt, lastSyntheticAttemptAt, decision]
	const cases = [
		// Fresh organic suppresses; stale organic triggers.
		[start + 15_000, start, null, 'skip'],
		[start + minuteMs, start, null, 'run'],
		// After a synthetic success or failure, the cooldown holds for an hour.
		[start + minuteMs, start, start, 'skip'],
		[start + 30_000, null, start, 'skip'],
		[start + hourMs - 1, null, start, 'skip'],
		[start + hourMs, null, start, 'run'],
	] as const
	expect(
		cases.map(([now, lastSuccessAt, lastSyntheticAttemptAt]) =>
			decideExecuteHealthProbe({ now, lastSuccessAt, lastSyntheticAttemptAt }),
		),
	).toEqual(cases.map(([, , , decision]) => decision))

	// No traffic across many minute ticks stays at most once per hour.
	expect(
		[59, 180, 61].map((count) =>
			countExecuteHealthSynthetics({
				ticks: ticks(count),
				lastSuccessAt: null,
			}),
		),
	).toEqual([1, 3, 2])
})

test('stale or missing telemetry is unknown, not an outage or a fresh healthy signal', () => {
	const missing = view(start)
	expect(missing.status).toBe('unknown')
	expect(missing.source).toBeNull()
	expect(missing.lastVerifiedAt).toBeNull()
	expect(missing.detail).toMatch(/not recently exercised/i)
	expect(missing.detail).toMatch(/not an outage/i)
	expect(missing.detail).not.toMatch(/operational|down|outage confirmed/i)

	const stale = view(start + recentMs, { lastSuccessAt: start })
	expect(stale).toMatchObject({
		status: 'unknown',
		source: 'organic',
		lastVerifiedAt: iso(start),
		freshnessMs: recentMs,
	})
	expect(stale.detail).toMatch(/not recently exercised/i)

	const failedSynthetic = view(start + minuteMs, {
		lastSyntheticAttemptAt: start,
		lastSyntheticError: 'MCP execute returned isError',
	})
	expect(failedSynthetic.status).toBe('unknown')
	expect(failedSynthetic.detail).toMatch(/not an outage/i)
	expect(failedSynthetic.detail).toMatch(/caller-code errors/i)

	const staleOrganicAfterFailedSynthetic = view(start + recentMs, {
		lastSuccessAt: start,
		lastSyntheticAttemptAt: start + minuteMs,
		lastSyntheticError: 'HTTP 500',
	})
	expect(staleOrganicAfterFailedSynthetic.status).toBe('unknown')
	expect(staleOrganicAfterFailedSynthetic.source).toBe('organic')
	expect(staleOrganicAfterFailedSynthetic.detail).toMatch(
		/missing or stale telemetry/i,
	)
	expect(staleOrganicAfterFailedSynthetic.detail).not.toMatch(
		/last synthetic attempt failed/i,
	)
})

test('organic success within the hour is recent, even when synthetic is unconfigured', () => {
	const aFewMinutesOld = view(start + 173_132, {
		lastSuccessAt: start,
		syntheticConfigured: false,
	})
	expect(aFewMinutesOld).toMatchObject({
		status: 'recent',
		source: 'organic',
		lastVerifiedAt: iso(start),
		freshnessMs: 173_132,
	})
	expect(aFewMinutesOld.detail).toMatch(/organic/i)
	expect(aFewMinutesOld.detail).toMatch(/2m ago/)
	expect(aFewMinutesOld.detail).not.toMatch(/not recently exercised/i)
	expect(aFewMinutesOld.detail).not.toMatch(/not configured/i)

	for (const organic of [
		view(start + recentMs - 1, {
			lastSuccessAt: start,
			syntheticConfigured: false,
		}),
		view(start + 5_000, { lastSuccessAt: start }),
	]) {
		expect(organic).toMatchObject({
			status: 'recent',
			source: 'organic',
			lastVerifiedAt: iso(start),
		})
		expect(organic.detail).toMatch(/organic/i)
	}
})

test('stale incoming last-success does not rewind a newer stored timestamp', () => {
	const cases = [
		[start, start + 10_000, start + 10_000],
		[start + 10_000, start, start + 10_000],
		[null, start, start],
		[start, null, start],
		[null, null, null],
	] as const
	expect(cases.map(([a, b]) => mergeExecuteLastSuccess(a, b))).toEqual(
		cases.map(([, , merged]) => merged),
	)
})

test('synthetic success plus heartbeat echo stays synthetic; later organic is organic', () => {
	const heartbeatEchoAt = start + 2_000
	const synthetic = {
		lastSuccessAt: heartbeatEchoAt,
		lastSyntheticAttemptAt: start,
		lastSyntheticSuccessAt: start,
	}
	for (const now of [start + 5_000, start + 30 * minuteMs]) {
		const echoed = view(now, synthetic)
		expect(echoed).toMatchObject({
			status: 'recent',
			source: 'synthetic',
			lastVerifiedAt: iso(heartbeatEchoAt),
		})
		expect(echoed.detail).toMatch(/hourly authenticated MCP execute probe/i)
	}

	expect(
		view(start + 3 * minuteMs, {
			...synthetic,
			lastSuccessAt: start + 2 * minuteMs,
		}),
	).toMatchObject({
		source: 'organic',
		status: 'recent',
		lastVerifiedAt: iso(start + 2 * minuteMs),
	})
})

test('ticks: unconfigured fallback skips without claiming budget; public reads never run; claimed ticks record failures', async () => {
	let runs = 0
	const runSynthetic = async () => {
		runs += 1
		return { ok: false, error: 'timeout' }
	}
	const skipped = await applyExecuteHealthTick({
		...idleTick,
		now: start + minuteMs,
		syntheticConfigured: false,
		runSynthetic,
	})
	expect(runs).toBe(0)
	expect(skipped.lastSyntheticAttemptAt).toBeNull()
	expect(skipped.lastSyntheticError).toBeNull()
	const unconfigured = view(start + minuteMs, skipped)
	expect(unconfigured.status).toBe('unknown')
	expect(unconfigured.detail).toMatch(/not configured/i)
	expect(unconfigured.detail).not.toMatch(/last synthetic attempt failed/i)

	const publicRead = await applyExecuteHealthTick({
		...idleTick,
		now: start + 15_000,
		lastSuccessAt: start,
		runSynthetic: async () => {
			throw new Error('public status GET must not run a paid execute')
		},
	})
	expect(publicRead.lastSyntheticAttemptAt).toBeNull()

	const ran = await applyExecuteHealthTick({
		...idleTick,
		now: start + minuteMs,
		lastSuccessAt: start,
		runSynthetic,
	})
	expect(runs).toBe(1)
	expect(ran.lastSyntheticAttemptAt).toBe(start + minuteMs)
	expect(ran.lastSyntheticError).toBe('timeout')
	expect(ran.lastSyntheticSuccessAt).toBeNull()
})

test('stale stored cron snapshot refreshes from live origin evidence and stays organic', async () => {
	const stored = start
	const live = start + 105_000
	const now = start + 121_000
	expect(
		shouldRefreshExecuteLastSuccess({ now, storedLastSuccessAt: stored }),
	).toBe(true)

	let fetches = 0
	const resolved = await resolvePublicExecuteLastSuccess({
		now,
		storedLastSuccessAt: stored,
		fetchLive: async () => {
			fetches += 1
			return live
		},
	})
	expect(fetches).toBe(1)
	expect(resolved).toEqual({ persist: true, lastSuccessAt: live })

	const refreshed = view(now, {
		lastSuccessAt: resolved.lastSuccessAt,
		lastSyntheticAttemptAt: stored,
		lastSyntheticError: 'HTTP 500',
	})
	expect(refreshed).toMatchObject({
		status: 'recent',
		source: 'organic',
		lastVerifiedAt: iso(live),
	})
	expect(refreshed.detail).toMatch(/organic/i)
	expect(refreshed.detail).not.toMatch(/last synthetic attempt failed/i)

	let skippedFetches = 0
	expect(
		await resolvePublicExecuteLastSuccess({
			now: start + 15_000,
			storedLastSuccessAt: start,
			fetchLive: async () => {
				skippedFetches += 1
				return start + 10_000
			},
		}),
	).toEqual({ persist: false, lastSuccessAt: start })
	expect(skippedFetches).toBe(0)

	expect(
		await resolvePublicExecuteLastSuccess({
			now,
			storedLastSuccessAt: stored,
			fetchLive: async () => null,
		}),
	).toEqual({ persist: false, lastSuccessAt: stored })

	// A concurrent writer that stored something newer during the fetch wins;
	// an older concurrent write loses to live evidence.
	for (const [duringFetch, expected] of [
		[start + 120_000, { persist: false, lastSuccessAt: start + 120_000 }],
		[start + 80_000, { persist: true, lastSuccessAt: live }],
	] as const) {
		let concurrentStored = stored
		expect(
			await resolvePublicExecuteLastSuccess({
				now,
				storedLastSuccessAt: stored,
				fetchLive: async () => {
					concurrentStored = duringFetch
					return live
				},
				readStoredAfterFetch: () => concurrentStored,
			}),
		).toEqual(expected)
	}
})

test('synthetic maintenance errors keep origin reason instead of collapsing to HTTP status', () => {
	const initializeFailed =
		'Authenticated MCP execute probe initialize failed: HTTP 401'
	const cases = [
		[
			500,
			{
				ok: false,
				reason: 'not-configured',
				error: 'canary is not configured',
			},
			{ ok: false, error: 'not-configured' },
		],
		[
			500,
			{ ok: false, error: initializeFailed },
			{ ok: false, error: initializeFailed },
		],
		[200, { ok: true }, { ok: true, error: null }],
		[502, null, { ok: false, error: 'HTTP 502' }],
	] as const
	expect(
		cases.map(([status, body]) =>
			readExecuteHealthSyntheticResult({ status, body }),
		),
	).toEqual(cases.map(([, , expected]) => expected))
})
