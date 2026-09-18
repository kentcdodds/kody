import { expect, test, vi } from 'vitest'

import {
	buildJevSearchSkinnyCard,
	jevSearchMinKeepScore,
	jevSearchWideRecallLimit,
	rerankSearchCandidatesWithJev,
	resolveJevSearchRecallLimit,
} from './search-jev-rerank.ts'
import { type SearchCandidate } from './search-types.ts'

function makeCandidate(
	overrides: Partial<SearchCandidate> & {
		id: string
		title: string
	},
): SearchCandidate {
	return {
		match: {
			type: 'capability',
			id: overrides.id,
			entityRef: `capability:${overrides.id}`,
			title: overrides.title,
			description: `${overrides.title} description`,
			domain: 'meta',
			usage: 'example',
		},
		type: 'capability',
		id: overrides.id,
		title: overrides.title,
		searchFields: [overrides.title],
		scoreComponents: {
			base: 1,
			lexical: 1,
			vector: 0,
			entityMatch: 0,
			providerEntityAffinity: 0,
			actionMatch: 0,
			taskAffinity: 0,
			appAvailability: 0,
			wrapperWorkflow: 0,
			constraint: 0,
			final: 1,
		},
		...overrides,
	}
}

test('resolveJevSearchRecallLimit widens only when requested', () => {
	expect(resolveJevSearchRecallLimit({ limit: 15, widerRecall: false })).toBe(
		15,
	)
	expect(resolveJevSearchRecallLimit({ limit: 15, widerRecall: true })).toBe(
		jevSearchWideRecallLimit,
	)
	expect(resolveJevSearchRecallLimit({ limit: 80, widerRecall: true })).toBe(80)
})

test('buildJevSearchSkinnyCard keeps one-line summary and domain', () => {
	const card = buildJevSearchSkinnyCard(
		makeCandidate({
			id: 'meta.search',
			title: 'search',
		}),
		3,
	)
	expect(card).toEqual({
		index: 3,
		type: 'capability',
		id: 'meta.search',
		title: 'search',
		summary: 'search description',
		domain: 'meta',
	})
})

test('rerankSearchCandidatesWithJev skips offline and flag-off without AI', async () => {
	const candidates = [
		makeCandidate({ id: 'a', title: 'A' }),
		makeCandidate({ id: 'b', title: 'B' }),
	]
	const intent = {
		normalizedQuery: 'send email',
		tokens: ['send', 'email'],
		meaningfulTokens: ['send', 'email'],
		phrases: ['send email'],
		task: { name: 'inspect' as const, confidence: 0.8 },
		actions: [],
		entities: [],
		constraints: [],
		confidence: 0.8,
	}

	const offline = await rerankSearchCandidatesWithJev({
		env: {} as Env,
		query: 'send email',
		intent,
		candidates,
		limit: 1,
		offline: true,
		enabled: true,
	})
	expect(offline.outcome).toBe('skipped-offline')
	expect(offline.candidates).toEqual([candidates[0]])

	const flagOff = await rerankSearchCandidatesWithJev({
		env: { AI: { run: vi.fn() } } as unknown as Env,
		query: 'send email',
		intent,
		candidates,
		limit: 1,
		offline: false,
		enabled: false,
	})
	expect(flagOff.outcome).toBe('skipped-flag-off')
})

test('rerankSearchCandidatesWithJev applies Score order and drops low scores', async () => {
	const candidates = [
		makeCandidate({ id: 'noise', title: 'Noise' }),
		makeCandidate({ id: 'email', title: 'Email' }),
		makeCandidate({ id: 'weak', title: 'Weak' }),
	]
	const intent = {
		normalizedQuery: 'send email',
		tokens: ['send', 'email'],
		meaningfulTokens: ['send', 'email'],
		phrases: ['send email'],
		task: { name: 'inspect' as const, confidence: 0.9 },
		actions: [],
		entities: [],
		constraints: [],
		confidence: 0.9,
	}
	const run = vi.fn(async () => ({
		answers: {
			c0: { type: 'score', score: 0.2, confidence: 0.9 },
			c1: { type: 'score', score: 2.7, confidence: 0.95 },
			c2: {
				type: 'score',
				score: jevSearchMinKeepScore - 0.2,
				confidence: 0.8,
			},
		},
	}))

	const result = await rerankSearchCandidatesWithJev({
		env: { AI: { run } } as unknown as Env,
		query: 'send email',
		intent,
		candidates,
		limit: 2,
		offline: false,
		enabled: true,
	})

	expect(result.outcome).toBe('applied')
	expect(result.candidates.map((candidate) => candidate.id)).toEqual(['email'])
	expect(result.droppedCount).toBe(2)
	expect(result.top1Type).toBe('capability')
	expect(run).toHaveBeenCalledOnce()
	expect(run.mock.calls[0]?.[0]).toBe('typesafe/jev')
})

test('rerankSearchCandidatesWithJev falls back to hybrid order when every score is dropped', async () => {
	const candidates = [
		makeCandidate({ id: 'first', title: 'First' }),
		makeCandidate({ id: 'second', title: 'Second' }),
	]
	const intent = {
		normalizedQuery: 'send email',
		tokens: ['send', 'email'],
		meaningfulTokens: ['send', 'email'],
		phrases: ['send email'],
		task: { name: 'inspect' as const, confidence: 0.9 },
		actions: [],
		entities: [],
		constraints: [],
		confidence: 0.9,
	}
	const run = vi.fn(async () => ({
		answers: {
			c0: {
				type: 'score',
				score: jevSearchMinKeepScore - 1,
				confidence: 0.9,
			},
			c1: {
				type: 'score',
				score: jevSearchMinKeepScore - 0.1,
				confidence: 0.95,
			},
		},
	}))

	const result = await rerankSearchCandidatesWithJev({
		env: { AI: { run } } as unknown as Env,
		query: 'send email',
		intent,
		candidates,
		limit: 2,
		offline: false,
		enabled: true,
	})

	expect(result.outcome).toBe('fallback-empty-after-drop')
	expect(result.candidates.map((candidate) => candidate.id)).toEqual([
		'first',
		'second',
	])
})

test('rerankSearchCandidatesWithJev falls back on AI errors and never returns blank', async () => {
	const candidates = [
		makeCandidate({ id: 'a', title: 'A' }),
		makeCandidate({ id: 'b', title: 'B' }),
	]
	const intent = {
		normalizedQuery: 'packages',
		tokens: ['packages'],
		meaningfulTokens: ['packages'],
		phrases: ['packages'],
		task: { name: 'inspect' as const, confidence: 0.7 },
		actions: [],
		entities: [],
		constraints: [],
		confidence: 0.7,
	}
	const run = vi.fn(async () => {
		throw new Error('gateway down')
	})
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

	const result = await rerankSearchCandidatesWithJev({
		env: { AI: { run } } as unknown as Env,
		query: 'packages',
		intent,
		candidates,
		limit: 2,
		offline: false,
		enabled: true,
	})

	expect(result.outcome).toBe('fallback-error')
	expect(result.candidates.map((candidate) => candidate.id)).toEqual(['a', 'b'])
	expect(warn).toHaveBeenCalled()
	warn.mockRestore()
})
