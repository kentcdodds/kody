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
		now: start + recentMs,
		lastSuccessAt: start,
		lastSyntheticAttemptAt: null,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: null,
		syntheticConfigured: true,
	})
	expect(stale.status).toBe('unknown')
	expect(stale.source).toBe('organic')
	expect(stale.lastVerifiedAt).toBe(new Date(start).toISOString())
	expect(stale.freshnessMs).toBe(recentMs)
	expect(stale.detail).toMatch(/not recently exercised/i)
})

test('minutes-old organic success stays recent even when synthetic is unconfigured', () => {
	const aFewMinutesOld = deriveExecuteHealthView({
		now: start + 173_132,
		lastSuccessAt: start,
		lastSyntheticAttemptAt: null,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: null,
		syntheticConfigured: false,
	})
	expect(aFewMinutesOld.status).toBe('recent')
	expect(aFewMinutesOld.source).toBe('organic')
	expect(aFewMinutesOld.lastVerifiedAt).toBe(new Date(start).toISOString())
	expect(aFewMinutesOld.freshnessMs).toBe(173_132)
	expect(aFewMinutesOld.detail).toMatch(/organic/i)
	expect(aFewMinutesOld.detail).toMatch(/2m ago/)
	expect(aFewMinutesOld.detail).not.toMatch(/not recently exercised/i)
	expect(aFewMinutesOld.detail).not.toMatch(/not configured/i)

	const almostHourOld = deriveExecuteHealthView({
		now: start + recentMs - 1,
		lastSuccessAt: start,
		lastSyntheticAttemptAt: null,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: null,
		syntheticConfigured: false,
	})
	expect(almostHourOld.status).toBe('recent')
	expect(almostHourOld.source).toBe('organic')
	expect(almostHourOld.detail).toMatch(/organic/i)
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

	const staleOrganicAfterFailedSynthetic = deriveExecuteHealthView({
		now: start + recentMs,
		lastSuccessAt: start,
		lastSyntheticAttemptAt: start + minuteMs,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: 'HTTP 500',
		syntheticConfigured: true,
	})
	expect(staleOrganicAfterFailedSynthetic.status).toBe('unknown')
	expect(staleOrganicAfterFailedSynthetic.source).toBe('organic')
	expect(staleOrganicAfterFailedSynthetic.detail).toMatch(
		/missing or stale telemetry/i,
	)
	expect(staleOrganicAfterFailedSynthetic.detail).not.toMatch(
		/last synthetic attempt failed/i,
	)

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

test('stale incoming last-success does not rewind a newer stored timestamp', () => {
	expect(mergeExecuteLastSuccess(start, start + 10_000)).toBe(start + 10_000)
	expect(mergeExecuteLastSuccess(start + 10_000, start)).toBe(start + 10_000)
	expect(mergeExecuteLastSuccess(null, start)).toBe(start)
	expect(mergeExecuteLastSuccess(start, null)).toBe(start)
	expect(mergeExecuteLastSuccess(null, null)).toBeNull()
})

test('synthetic success plus heartbeat echo stays synthetic; later organic is organic', () => {
	const syntheticAt = start
	const heartbeatEchoAt = start + 2_000
	const echoed = deriveExecuteHealthView({
		now: start + 5_000,
		lastSuccessAt: heartbeatEchoAt,
		lastSyntheticAttemptAt: start,
		lastSyntheticSuccessAt: syntheticAt,
		lastSyntheticError: null,
		syntheticConfigured: true,
	})
	expect(echoed.status).toBe('recent')
	expect(echoed.source).toBe('synthetic')
	expect(echoed.lastVerifiedAt).toBe(new Date(heartbeatEchoAt).toISOString())
	expect(echoed.detail).toMatch(/hourly authenticated MCP execute probe/i)

	const laterOrganic = deriveExecuteHealthView({
		now: start + 3 * minuteMs,
		lastSuccessAt: start + 2 * minuteMs,
		lastSyntheticAttemptAt: start,
		lastSyntheticSuccessAt: syntheticAt,
		lastSyntheticError: null,
		syntheticConfigured: true,
	})
	expect(laterOrganic.source).toBe('organic')
	expect(laterOrganic.status).toBe('recent')
	expect(laterOrganic.lastVerifiedAt).toBe(
		new Date(start + 2 * minuteMs).toISOString(),
	)

	const syntheticStillRecent = deriveExecuteHealthView({
		now: start + 30 * minuteMs,
		lastSuccessAt: heartbeatEchoAt,
		lastSyntheticAttemptAt: start,
		lastSyntheticSuccessAt: syntheticAt,
		lastSyntheticError: null,
		syntheticConfigured: true,
	})
	expect(syntheticStillRecent.status).toBe('recent')
	expect(syntheticStillRecent.source).toBe('synthetic')
	expect(syntheticStillRecent.detail).toMatch(
		/hourly authenticated MCP execute probe/i,
	)
})

test('unconfigured fallback does not claim the hourly budget or hide the not-configured copy', async () => {
	let runs = 0
	const skipped = await applyExecuteHealthTick({
		now: start + minuteMs,
		lastSuccessAt: null,
		lastSyntheticAttemptAt: null,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: null,
		syntheticConfigured: false,
		runSynthetic: async () => {
			runs += 1
			return { ok: false, error: 'not-configured' }
		},
	})
	expect(runs).toBe(0)
	expect(skipped.lastSyntheticAttemptAt).toBeNull()
	expect(skipped.lastSyntheticError).toBeNull()

	const view = deriveExecuteHealthView({
		now: start + minuteMs,
		...skipped,
	})
	expect(view.status).toBe('unknown')
	expect(view.detail).toMatch(/not configured/i)
	expect(view.detail).not.toMatch(/last synthetic attempt failed/i)
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

test('stale stored cron snapshot refreshes from live origin evidence and stays organic', async () => {
	const stored = start
	const live = start + 105_000
	const now = start + 121_000
	expect(
		shouldRefreshExecuteLastSuccess({
			now,
			storedLastSuccessAt: stored,
		}),
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
	expect(resolved.persist).toBe(true)
	expect(resolved.lastSuccessAt).toBe(live)

	const view = deriveExecuteHealthView({
		now,
		lastSuccessAt: resolved.lastSuccessAt,
		lastSyntheticAttemptAt: stored,
		lastSyntheticSuccessAt: null,
		lastSyntheticError: 'HTTP 500',
		syntheticConfigured: true,
	})
	expect(view.status).toBe('recent')
	expect(view.source).toBe('organic')
	expect(view.lastVerifiedAt).toBe(new Date(live).toISOString())
	expect(view.detail).toMatch(/organic/i)
	expect(view.detail).not.toMatch(/last synthetic attempt failed/i)

	let skippedFetches = 0
	const freshStored = await resolvePublicExecuteLastSuccess({
		now: start + 15_000,
		storedLastSuccessAt: start,
		fetchLive: async () => {
			skippedFetches += 1
			return start + 10_000
		},
	})
	expect(skippedFetches).toBe(0)
	expect(freshStored.persist).toBe(false)
	expect(freshStored.lastSuccessAt).toBe(start)

	const originDown = await resolvePublicExecuteLastSuccess({
		now,
		storedLastSuccessAt: stored,
		fetchLive: async () => null,
	})
	expect(originDown.persist).toBe(false)
	expect(originDown.lastSuccessAt).toBe(stored)

	let concurrentStored = stored
	const newerDuringFetch = start + 120_000
	const raced = await resolvePublicExecuteLastSuccess({
		now,
		storedLastSuccessAt: stored,
		fetchLive: async () => {
			concurrentStored = newerDuringFetch
			return live
		},
		readStoredAfterFetch: () => concurrentStored,
	})
	expect(raced.lastSuccessAt).toBe(newerDuringFetch)
	expect(raced.persist).toBe(false)

	let olderConcurrentStored = stored
	const olderDuringFetch = start + 80_000
	const liveWinsRace = await resolvePublicExecuteLastSuccess({
		now,
		storedLastSuccessAt: stored,
		fetchLive: async () => {
			olderConcurrentStored = olderDuringFetch
			return live
		},
		readStoredAfterFetch: () => olderConcurrentStored,
	})
	expect(liveWinsRace.lastSuccessAt).toBe(live)
	expect(liveWinsRace.persist).toBe(true)
})

test('synthetic maintenance errors keep origin reason instead of collapsing to HTTP status', () => {
	expect(
		readExecuteHealthSyntheticResult({
			status: 500,
			body: {
				ok: false,
				reason: 'not-configured',
				error: 'Execute health canary is not configured',
			},
		}),
	).toEqual({ ok: false, error: 'not-configured' })
	expect(
		readExecuteHealthSyntheticResult({
			status: 500,
			body: {
				ok: false,
				error: 'Authenticated MCP execute probe initialize failed: HTTP 401',
			},
		}),
	).toEqual({
		ok: false,
		error: 'Authenticated MCP execute probe initialize failed: HTTP 401',
	})
	expect(
		readExecuteHealthSyntheticResult({
			status: 200,
			body: { ok: true },
		}),
	).toEqual({ ok: true, error: null })
	expect(readExecuteHealthSyntheticResult({ status: 502, body: null })).toEqual(
		{ ok: false, error: 'HTTP 502' },
	)
})
