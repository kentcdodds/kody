import { expect, test, vi } from 'vitest'
import {
	reconcileSearchPhaseTimings,
	runWithSearchDeadline,
	SearchDeadlineError,
	toSearchServerTiming,
} from './search-timing.ts'

test('runWithSearchDeadline returns results that finish in time and rejects hung work', async () => {
	await expect(
		runWithSearchDeadline(async () => 'ranked', 1_000),
	).resolves.toBe('ranked')

	vi.useFakeTimers()
	try {
		let runSignal: AbortSignal | undefined
		const settled = runWithSearchDeadline((signal) => {
			runSignal = signal
			return new Promise(() => {})
		}, 1_000).catch((error: unknown) => error)
		expect(runSignal?.aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(1_000)
		const error = await settled
		expect(error).toBeInstanceOf(SearchDeadlineError)
		expect(runSignal?.aborted).toBe(true)
		expect(runSignal?.reason).toBe(error)
		expect((error as Error).message).toContain(
			'Search did not finish within 1s, so Kody stopped waiting before the MCP request timed out.',
		)
	} finally {
		vi.useRealTimers()
	}
})

test('reconcileSearchPhaseTimings sums exclusive tiles and leaves overlapping detail out of exclusiveMs', () => {
	const reconciled = reconcileSearchPhaseTimings({
		durationMs: 12389,
		phaseTimings: {
			queryUnderstandingMs: 0,
			candidateGenerationMs: 58,
			rerankingMs: 89,
			queryEmbeddingMs: 0,
			capabilityCandidatesMs: 58,
			packageCandidatesMs: 55,
			retrieversMs: 725,
			rowAndRegistryLoadMs: 1967,
			memoryEnrichmentMs: 2114,
			memoryEnrichmentWaitMs: 0,
			formattingMs: 0,
			usernameLookupMs: 12,
			identityResolutionMs: 8,
			loadAndRankMs: 2114,
			searchUnifiedMs: 147,
			waitingItemsMs: 4000,
			firstSearchStampMs: 40,
			onboardingNoticeMs: 80,
		},
	})

	expect(reconciled.exclusiveMs).toBe(12 + 8 + 2114 + 40 + 80 + 4000 + 0)
	expect(reconciled.unaccountedMs).toBe(
		12389 - (12 + 8 + 2114 + 40 + 80 + 4000),
	)
	expect(reconciled.loadAndRankMs).toBe(2114)
	expect(reconciled.memoryEnrichmentMs).toBe(2114)
})

test('reconcileSearchPhaseTimings counts rowAndRegistryLoadMs only when loadAndRankMs is absent', () => {
	const listMode = reconcileSearchPhaseTimings({
		durationMs: 3000,
		phaseTimings: {
			loadAndRankMs: 2000,
			rowAndRegistryLoadMs: 1900,
			formattingMs: 10,
		},
	})
	expect(listMode.exclusiveMs).toBe(2010)

	const entityMode = reconcileSearchPhaseTimings({
		durationMs: 800,
		phaseTimings: {
			usernameLookupMs: 5,
			rowAndRegistryLoadMs: 400,
			entityResolveMs: 200,
			firstSearchStampMs: 20,
		},
	})
	expect(entityMode.exclusiveMs).toBe(625)
	expect(entityMode.unaccountedMs).toBe(175)
})

test('toSearchServerTiming maps list phases and emits jevRerank only on the flag path', () => {
	const phaseTimings = {
		queryUnderstandingMs: 4,
		candidateGenerationMs: 20,
		rerankingMs: 12,
		jevRerankMs: 1280,
		formattingMs: 3,
		memoryEnrichmentTimedOut: false,
	}
	const flagOff = toSearchServerTiming({
		phaseTimings,
		jevRerank: {
			enabled: false,
			outcome: 'skipped-flag-off',
			candidatesBefore: 8,
			candidatesAfter: 8,
			droppedCount: 0,
			meanConfidence: null,
			top1Type: 'capability',
		},
	})
	expect(flagOff).toEqual([
		{ name: 'queryUnderstanding', durationMs: 4 },
		{ name: 'candidateGeneration', durationMs: 20 },
		{ name: 'reranking', durationMs: 12 },
		{ name: 'formatting', durationMs: 3 },
	])

	const applied = toSearchServerTiming({
		phaseTimings,
		jevRerank: {
			enabled: true,
			outcome: 'applied',
			candidatesBefore: 50,
			candidatesAfter: 8,
			droppedCount: 12,
			meanConfidence: 0.8,
			top1Type: 'capability',
		},
	})
	expect(applied).toEqual([
		{ name: 'queryUnderstanding', durationMs: 4 },
		{ name: 'candidateGeneration', durationMs: 20 },
		{ name: 'reranking', durationMs: 12 },
		{ name: 'jevRerank', durationMs: 1280 },
		{ name: 'formatting', durationMs: 3 },
	])

	const fallback = toSearchServerTiming({
		phaseTimings,
		jevRerank: {
			enabled: true,
			outcome: 'fallback-error',
			candidatesBefore: 50,
			candidatesAfter: 8,
			droppedCount: 0,
			meanConfidence: null,
			top1Type: 'capability',
		},
	})
	expect(fallback.find((entry) => entry.name === 'jevRerank')).toEqual({
		name: 'jevRerank',
		durationMs: 1280,
	})
})
