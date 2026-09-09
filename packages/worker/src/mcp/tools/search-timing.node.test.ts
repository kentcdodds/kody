import { expect, test } from 'vitest'
import { reconcileSearchPhaseTimings } from './search-timing.ts'

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
