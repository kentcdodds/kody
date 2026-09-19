import { expect, test } from 'vitest'

import {
	attachHighConfidenceExportCallContract,
	shouldInlineExportCallContract,
} from './search-export-call-contract.ts'
import { type SearchMatch } from './search-format-types.ts'
import { type SearchCandidate } from './search-types.ts'

function makeExportMatch(
	overrides: Partial<Extract<SearchMatch, { type: 'package' }>> = {},
): Extract<SearchMatch, { type: 'package' }> {
	return {
		type: 'package',
		packageId: 'pkg-1',
		kodyId: 'home-controls',
		name: '@kody/home-controls',
		title: '@kody/home-controls setBondAreaShades',
		description: 'Dim bond area shades.',
		tags: ['home'],
		hasApp: false,
		hidden: false,
		exportSubpath: './bond-area-shades',
		actionMatches: [
			{
				subpath: './bond-area-shades',
				description: 'Dim bond area shades.',
				typeDefinition:
					'export declare function setBondAreaShades(params: { level: number }): Promise<void>',
				functions: [
					{
						name: 'setBondAreaShades',
						description: 'Dim bond area shades.',
						typeDefinition:
							'export declare function setBondAreaShades(params: { level: number }): Promise<void>',
					},
				],
				score: 0.9,
				matchedTerms: ['bond', 'shades'],
			},
		],
		...overrides,
	}
}

function makeCandidateFromMatch(
	match: SearchMatch,
	final: number,
): SearchCandidate {
	return {
		match,
		type: match.type,
		id:
			match.type === 'package' && match.exportSubpath
				? `${match.kodyId}#${match.exportSubpath}`
				: match.type === 'package'
					? match.kodyId
					: 'id',
		title: 'title' in match ? match.title : 'title',
		searchFields: ['title'],
		scoreComponents: {
			base: final,
			lexical: final,
			vector: 0,
			entityMatch: 0,
			providerEntityAffinity: 0,
			actionMatch: 0,
			taskAffinity: 0,
			appAvailability: 0,
			wrapperWorkflow: 0,
			constraint: 0,
			final,
		},
	}
}

test('shouldInlineExportCallContract requires high confidence', () => {
	const top = makeExportMatch()
	const weakSecond = makeExportMatch({
		exportSubpath: './other',
		kodyId: 'other-pkg',
		actionMatches: [
			{
				subpath: './other',
				description: null,
				typeDefinition: null,
				functions: [{ name: 'other', description: null, typeDefinition: null }],
				score: 0.2,
				matchedTerms: ['other'],
			},
		],
	})
	const rankedClear = [
		makeCandidateFromMatch(top, 1.2),
		makeCandidateFromMatch(weakSecond, 0.3),
	]
	expect(
		shouldInlineExportCallContract({
			matches: [top, weakSecond],
			rankedCandidates: rankedClear,
			jevOutcome: 'skipped-clear-winner',
			jevMeanConfidence: null,
		}),
	).toBe(true)

	const rankedTight = [
		makeCandidateFromMatch(top, 1.0),
		makeCandidateFromMatch(weakSecond, 0.95),
	]
	expect(
		shouldInlineExportCallContract({
			matches: [top, weakSecond],
			rankedCandidates: rankedTight,
			jevOutcome: 'skipped-flag-off',
			jevMeanConfidence: null,
		}),
	).toBe(false)

	expect(
		shouldInlineExportCallContract({
			matches: [top],
			rankedCandidates: rankedClear,
			jevOutcome: 'applied',
			jevMeanConfidence: 0.5,
		}),
	).toBe(false)

	expect(
		shouldInlineExportCallContract({
			matches: [top],
			rankedCandidates: rankedClear,
			jevOutcome: 'applied',
			jevMeanConfidence: 0.85,
		}),
	).toBe(true)

	const rivalExport = makeExportMatch({
		exportSubpath: './curtains',
		actionMatches: [
			{
				subpath: './curtains',
				description: null,
				typeDefinition: null,
				functions: [
					{ name: 'setCurtains', description: null, typeDefinition: null },
				],
				score: 0.8,
				matchedTerms: ['curtains'],
			},
		],
	})
	expect(
		shouldInlineExportCallContract({
			matches: [top, rivalExport],
			rankedCandidates: rankedClear,
			jevOutcome: 'applied',
			jevMeanConfidence: 0.9,
		}),
	).toBe(false)
})

test('shouldInlineExportCallContract scores post-collapse matches, not pre-collapse index 0', () => {
	// Collapse dropped a leading synthesized MCP tool; matches[0] is a weak
	// export that must not inherit the dropped hit's score/gap.
	const droppedCapabilityMatch = {
		type: 'capability',
		id: 'cap-dropped',
		title: 'Dropped tool',
		description: null,
		domain: 'integrations',
		tags: [],
		score: 2.0,
		matchedTerms: ['tool'],
	} as SearchMatch
	const weakExport = makeExportMatch()
	const rival = makeExportMatch({
		kodyId: 'other-pkg',
		exportSubpath: './other',
		actionMatches: [
			{
				subpath: './other',
				description: null,
				typeDefinition: null,
				functions: [{ name: 'other', description: null, typeDefinition: null }],
				score: 0.2,
				matchedTerms: ['other'],
			},
		],
	})
	const rankedPreCollapse = [
		makeCandidateFromMatch(droppedCapabilityMatch, 2.0),
		makeCandidateFromMatch(weakExport, 0.5),
		makeCandidateFromMatch(rival, 0.45),
	]
	expect(
		shouldInlineExportCallContract({
			matches: [weakExport, rival],
			rankedCandidates: rankedPreCollapse,
			jevOutcome: 'skipped-clear-winner',
			jevMeanConfidence: null,
		}),
	).toBe(false)
})

test('attachHighConfidenceExportCallContract inlines import and types', () => {
	const top = makeExportMatch()
	const matches: Array<SearchMatch> = [top]
	const ranked = [makeCandidateFromMatch(top, 1.5)]
	attachHighConfidenceExportCallContract({
		matches,
		rankedCandidates: ranked,
		jevOutcome: 'skipped-small-pool',
		jevMeanConfidence: null,
	})
	expect(top.exportCallContract).toMatchObject({
		importSpecifier: 'kody:@kody/home-controls/bond-area-shades',
		usage: expect.stringContaining('setBondAreaShades'),
		typeDefinition: expect.stringContaining('setBondAreaShades'),
		functions: [expect.objectContaining({ name: 'setBondAreaShades' })],
	})
	expect(top.exportCallContract?.executeExample).toContain('setBondAreaShades')

	const weak: Array<SearchMatch> = [makeExportMatch()]
	attachHighConfidenceExportCallContract({
		matches: weak,
		rankedCandidates: [
			makeCandidateFromMatch(weak[0]!, 0.2),
			makeCandidateFromMatch(makeExportMatch({ kodyId: 'other' }), 0.19),
		],
		jevOutcome: 'skipped-flag-off',
		jevMeanConfidence: null,
	})
	expect(weak[0]).not.toHaveProperty('exportCallContract')
})
