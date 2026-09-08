import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { guideMetadataList } from '#worker/guide-catalog-modules.ts'
import { resolveMarkdownDocument } from '#worker/guides/document-sections.ts'
import { type GuideMetadata } from '#worker/guides/guide-types.ts'
import { lexicalScore } from '#worker/vectorize/scoring.ts'

import { type SearchEntityPlugin } from '../search-entity-plugin.ts'
import { maxChars } from '../search-constants.ts'
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
	const identityTokens = guideQueryTokens(identityPhrase)
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
		const headerLines = [
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
		]
		const header = headerLines.join('\n')
		let resolved
		try {
			resolved = resolveMarkdownDocument({
				markdown: detail.body,
				maxChars: Math.max(0, maxChars - header.length - 2),
				entityRef,
				...(detail.section ? { section: detail.section } : {}),
			})
		} catch (error) {
			throw new McpCallerError(
				error instanceof Error ? error.message : String(error),
				{ cause: error },
			)
		}
		const selectedRef = resolved.selected
			? buildEntityRef(detail.id, 'guide', resolved.selected.slug)
			: entityRef
		const modeLines = guideDetailModeLines(resolved)
		const bodyLines = [...headerLines, ...modeLines, '', resolved.markdown]
		return {
			markdown: bodyLines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'guide',
				id: detail.id,
				entityRef: selectedRef,
				title: detail.title,
				description: detail.description,
				usage: resolved.selected
					? `search({ entity: ${JSON.stringify(selectedRef)} })`
					: buildGuideUsage(detail.id),
				category: detail.category,
				slug: detail.slug,
				body: resolved.markdown,
				bodyMode: resolved.mode,
				section: resolved.selected
					? {
							title: resolved.selected.title,
							slug: resolved.selected.slug,
						}
					: null,
				sections: resolved.headings
					.filter((heading) => heading.level >= 2)
					.map((heading) => ({
						title: heading.title,
						slug: heading.slug,
						level: heading.level,
						entityRef: buildEntityRef(detail.id, 'guide', heading.slug),
					})),
				provider: detail.provider,
				lastVerified: detail.lastVerified,
			},
		}
	},
} satisfies SearchEntityPlugin<'guide'>

function guideDetailModeLines(resolved: {
	mode: 'full' | 'toc' | 'section'
	selected: { slug: string } | null
}) {
	switch (resolved.mode) {
		case 'full':
			return []
		case 'toc':
			return [
				'- Contents: oversized guide; open a heading with `{id}:guide#{slug}`',
			]
		case 'section':
			return resolved.selected
				? [`- Section: \`${resolved.selected.slug}\``]
				: []
		default: {
			const exhaustive: never = resolved.mode
			throw new Error(`Unsupported guide detail mode: ${exhaustive}`)
		}
	}
}
