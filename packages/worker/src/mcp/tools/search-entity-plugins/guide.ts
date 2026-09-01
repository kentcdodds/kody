import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { guideMetadataList } from '#worker/guide-catalog-modules.ts'
import { type GuideMetadata } from '#worker/guides/guide-types.ts'
import { lexicalScore } from '#worker/vectorize/scoring.ts'

import { type SearchEntityPlugin } from '../search-entity-plugin.ts'
import { buildEntityRef, buildGuideUsage } from '../search-format-helpers.ts'
import { buildCandidateBaseScore } from '../search-scoring.ts'
import {
	buildSearchPhrases,
	extractMeaningfulSearchTokens,
	extractSearchTokens,
	normalizeSearchText,
} from '../understand-search-query.ts'

const advertisedGuides = guideMetadataList.filter(
	(guide) => !guide.unadvertised,
)

function guideBelongsInDomain(domain: string | undefined) {
	return domain == null || domain === capabilityDomainNames.coding
}

function guideSearchText(guide: GuideMetadata) {
	return [guide.id, guide.slug, guide.title, guide.provider]
		.filter((value): value is string => Boolean(value))
		.join('\n')
}

const guideDiscoveryNoise = new Set([
	'guide',
	'guides',
	'docs',
	'documentation',
	'official',
])

function phraseHasMultipleTokens(phrase: string) {
	return extractSearchTokens(phrase).length >= 2
}

function guideQueryTokens(query: string) {
	return extractMeaningfulSearchTokens(query).filter(
		(token) => !guideDiscoveryNoise.has(token),
	)
}

function identityTokensCoveredByQuery(
	identityPhrase: string,
	queryTokens: ReadonlyArray<string>,
) {
	const identityTokens = extractSearchTokens(identityPhrase)
	if (identityTokens.length < 2) return false
	return identityTokens.every((token) => queryTokens.includes(token))
}

function guideHasStrongQueryMatch(query: string, guide: GuideMetadata) {
	const identity = normalizeSearchText(guideSearchText(guide))
	const tokens = guideQueryTokens(query)
	if (tokens.length === 0) return false
	const focusedQuery = tokens.join(' ')
	if (identity.includes(focusedQuery)) return true
	const idPhrase = normalizeSearchText(guide.id)
	const slugPhrase = normalizeSearchText(guide.slug)
	if (phraseHasMultipleTokens(idPhrase) && focusedQuery.includes(idPhrase)) {
		return true
	}
	if (
		phraseHasMultipleTokens(slugPhrase) &&
		focusedQuery.includes(slugPhrase)
	) {
		return true
	}
	if (identityTokensCoveredByQuery(idPhrase, tokens)) return true
	if (identityTokensCoveredByQuery(slugPhrase, tokens)) return true
	if (tokens.length === 1) {
		return extractSearchTokens(identity).includes(tokens[0] ?? '')
	}
	return buildSearchPhrases(tokens).some((phrase) => identity.includes(phrase))
}

export const guideSearchEntityPlugin = {
	type: 'guide',
	buildDescriptors(input) {
		if (!guideBelongsInDomain(input.domain)) return []
		return advertisedGuides.map((guide) => ({
			type: 'guide' as const,
			id: guide.id,
			title: guide.title,
			primaryAliases: [guide.id, guide.slug, guide.title],
			secondaryAliases: [
				guide.summary,
				...(guide.provider ? [guide.provider] : []),
				'official guide',
			],
		}))
	},
	buildCandidates(input) {
		if (!guideBelongsInDomain(input.domain)) return []
		return advertisedGuides
			.filter((guide) => guideHasStrongQueryMatch(input.query, guide))
			.map((guide) => {
				const lexical = lexicalScore(input.query, guideSearchText(guide))
				return {
					match: {
						type: 'guide' as const,
						id: guide.id,
						title: guide.title,
						description: guide.summary,
						category: guide.category,
						slug: guide.slug,
						provider: guide.provider,
					},
					type: 'guide' as const,
					id: guide.id,
					title: guide.title,
					searchFields: [
						guide.id,
						guide.slug,
						guide.title,
						...(guide.provider ? [guide.provider] : []),
					],
					identityFields: [guide.id, guide.slug],
					scoreComponents: buildCandidateBaseScore({
						lexical,
					}),
				}
			})
			.filter((candidate) => candidate.scoreComponents.base > 0)
	},
	formatSlimMatch({ match }) {
		return {
			type: 'guide',
			id: match.id,
			entityRef: buildEntityRef(match.id, 'guide'),
			title: match.title,
			description: match.description,
			usage: buildGuideUsage(match.id),
			category: match.category,
			slug: match.slug,
			provider: match.provider,
		}
	},
	formatEntityDetail(detail) {
		const entityRef = buildEntityRef(detail.id, 'guide')
		const lines = [
			`# Guide — \`${detail.id}\``,
			'',
			detail.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${entityRef}\``,
			`- Category: \`${detail.category}\``,
			`- Web: \`/guides/${detail.slug}\``,
			...(detail.provider ? [`- Provider: ${detail.provider}`] : []),
			...(detail.lastVerified
				? [`- Last verified: \`${detail.lastVerified}\``]
				: []),
			'',
			detail.body,
		]
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'guide',
				id: detail.id,
				entityRef,
				title: detail.title,
				description: detail.description,
				usage: buildGuideUsage(detail.id),
				category: detail.category,
				slug: detail.slug,
				body: detail.body,
				provider: detail.provider,
				lastVerified: detail.lastVerified,
			},
		}
	},
} satisfies SearchEntityPlugin<'guide'>
