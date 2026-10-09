import {
	legacyDocSlugAliases,
	legacyGuideIdAliases,
} from '#universal/docs-nav.ts'

type GuideIdentity = {
	id: string
	slug: string
	adminOnly?: boolean
	unadvertised?: boolean
}

export type ResolvedCatalogGuide = {
	id: string
	aliasSection?: string
}

/**
 * Entity lookup for `guide:{id}`. Accepts the catalog id, the page slug,
 * hyphen/underscore spelling, `legacyGuideIdAliases`, and former page
 * slugs in `legacyDocSlugAliases`.
 */
export function resolveCatalogGuide(
	guides: ReadonlyArray<GuideIdentity>,
	requestedId: string,
): ResolvedCatalogGuide | null {
	const direct = guides.find((guide) => guide.id === requestedId)
	if (direct) return { id: direct.id }

	const fromAlias = aliasHit(guides, requestedId)
	if (fromAlias) return fromAlias

	const underscored = requestedId.replaceAll('-', '_')
	if (underscored !== requestedId) {
		const byNormalizedId = guides.find((guide) => guide.id === underscored)
		if (byNormalizedId) return { id: byNormalizedId.id }
		const fromNormalizedAlias = aliasHit(guides, underscored)
		if (fromNormalizedAlias) return fromNormalizedAlias
	}

	const bySlug = guides.find(
		(guide) =>
			guide.slug === requestedId ||
			guide.slug.replaceAll('-', '_') === underscored,
	)
	if (bySlug) return { id: bySlug.id }

	return legacyDocSlugHit(guides, requestedId)
}

function legacyDocSlugHit(
	guides: ReadonlyArray<GuideIdentity>,
	requestedId: string,
): ResolvedCatalogGuide | null {
	const hyphenated = requestedId.replaceAll('_', '-')
	const alias =
		legacyDocSlugAliases[requestedId] ??
		(hyphenated === requestedId ? undefined : legacyDocSlugAliases[hyphenated])
	if (!alias) return null
	const guide = guides.find((candidate) => candidate.slug === alias.slug)
	if (!guide) return null
	return alias.fragment
		? { id: guide.id, aliasSection: alias.fragment }
		: { id: guide.id }
}

function aliasHit(
	guides: ReadonlyArray<GuideIdentity>,
	requestedId: string,
): ResolvedCatalogGuide | null {
	const alias = legacyGuideIdAliases[requestedId]
	if (!alias) return null
	const guide = guides.find((candidate) => candidate.id === alias.id)
	if (!guide) return null
	return alias.section
		? { id: guide.id, aliasSection: alias.section }
		: { id: guide.id }
}

function identityParts(value: string): Array<string> {
	return value
		.toLowerCase()
		.replaceAll('-', '_')
		.split('_')
		.filter((part) => part.length > 0)
}

/**
 * Guides whose id or slug contains every requested word as its own
 * segment. Used only on the not-found path. Unadvertised and, for
 * non-admins, admin-only guides are omitted.
 */
export function suggestCatalogGuideIds(
	guides: ReadonlyArray<GuideIdentity>,
	requestedId: string,
	options: { includeAdmin: boolean },
): Array<string> {
	const needleParts = identityParts(requestedId)
	if (needleParts.length === 0) return []
	const visible = guides.filter((guide) => {
		if (guide.unadvertised) return false
		if (guide.adminOnly && !options.includeAdmin) return false
		return true
	})
	const matches = visible
		.map((guide) => {
			const parts = new Set([
				...identityParts(guide.id),
				...identityParts(guide.slug),
			])
			const covered = needleParts.filter((part) => parts.has(part)).length
			const extra = [...parts].filter(
				(part) => !needleParts.includes(part),
			).length
			return { id: guide.id, covered, extra }
		})
		.filter((row) => row.covered === needleParts.length)
	matches.sort((a, b) => a.extra - b.extra || a.id.localeCompare(b.id))
	const bestExtra = matches[0]?.extra
	if (bestExtra == null) return []
	return matches
		.filter((row) => row.extra === bestExtra)
		.slice(0, 3)
		.map((row) => row.id)
}

export function guideNotFoundMessage(
	suggestions: ReadonlyArray<string>,
): string {
	if (suggestions.length === 0) return 'Guide not found.'
	const refs = suggestions.map((id) => `\`guide:${id}\``)
	const only = refs[0]
	if (refs.length === 1 && only) return `Guide not found. Did you mean ${only}?`
	const second = refs[1]
	if (refs.length === 2 && only && second) {
		return `Guide not found. Did you mean ${only} or ${second}?`
	}
	const last = refs[refs.length - 1]
	return `Guide not found. Did you mean ${refs.slice(0, -1).join(', ')}, or ${last}?`
}
