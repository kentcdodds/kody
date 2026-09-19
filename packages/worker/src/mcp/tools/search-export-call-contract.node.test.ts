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
	const hybridClear = [
		makeCandidateFromMatch(top, 1.2),
		makeCandidateFromMatch(weakSecond, 0.3),
	]
	expect(
		shouldInlineExportCallContract({
			matches: [top, weakSecond],
			hybridCandidates: hybridClear,
			jevOutcome: 'skipped-clear-winner',
			jevMeanConfidence: null,
		}),
	).toBe(true)

	const hybridTight = [
		makeCandidateFromMatch(top, 1.0),
		makeCandidateFromMatch(weakSecond, 0.95),
	]
	expect(
		shouldInlineExportCallContract({
			matches: [top, weakSecond],
			hybridCandidates: hybridTight,
			jevOutcome: 'skipped-flag-off',
			jevMeanConfidence: null,
		}),
	).toBe(false)

	expect(
		shouldInlineExportCallContract({
			matches: [top],
			hybridCandidates: hybridClear,
			jevOutcome: 'applied',
			jevMeanConfidence: 0.5,
		}),
	).toBe(false)

	expect(
		shouldInlineExportCallContract({
			matches: [top],
			hybridCandidates: hybridClear,
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
			hybridCandidates: hybridClear,
			jevOutcome: 'applied',
			jevMeanConfidence: 0.9,
		}),
	).toBe(false)
})

test('attachHighConfidenceExportCallContract inlines import and types', () => {
	const top = makeExportMatch()
	const matches: Array<SearchMatch> = [top]
	const hybrid = [makeCandidateFromMatch(top, 1.5)]
	attachHighConfidenceExportCallContract({
		matches,
		hybridCandidates: hybrid,
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
		hybridCandidates: [
			makeCandidateFromMatch(weak[0]!, 0.2),
			makeCandidateFromMatch(makeExportMatch({ kodyId: 'other' }), 0.19),
		],
		jevOutcome: 'skipped-flag-off',
		jevMeanConfidence: null,
	})
	expect(weak[0]).not.toHaveProperty('exportCallContract')
})
