import { listDocsNavSlugs, unadvertisedDocSlugs } from '#universal/docs-nav.ts'

/**
 * Single source of truth for guide ordering: the `/docs` reading order from
 * `#universal/docs-nav.ts`, followed by the unadvertised docs. Both
 * `#worker/guides/catalog.ts` (web catalog, `codingGuideGet` schema
 * description) and `tools/build-guide-catalog-modules.ts` (generated
 * metadata/full-catalog modules) sort their parsed guides through
 * `sortGuidesByAuthoredOrder` below, so the order can never silently drift
 * between the two.
 *
 * Adding a guide requires a docs-nav entry (or an `unadvertisedDocSlugs`
 * entry) — `sortGuidesByAuthoredOrder` throws immediately (surfacing in
 * `catalog.ts`'s module-scope `buildCatalog()` and in the generator) if a
 * parsed guide's slug is missing, or if the nav names a slug with no
 * matching guide.
 */
const guideOrder: ReadonlyArray<string> = [
	...listDocsNavSlugs(),
	...unadvertisedDocSlugs,
]

/**
 * Sorts `guides` into the authored order declared by the docs nav. Throws on
 * any mismatch between `guides` and `guideOrder` rather than silently
 * falling back to input order, so a guide added to `docs/guides/` without a
 * matching nav entry (or vice versa) fails loudly instead of quietly
 * reordering `codingGuideGet`'s schema description or the web catalog.
 */
export function sortGuidesByAuthoredOrder<T extends { slug: string }>(
	guides: ReadonlyArray<T>,
): ReadonlyArray<T> {
	const orderIndexBySlug = new Map(
		guideOrder.map((slug, index) => [slug, index]),
	)
	if (orderIndexBySlug.size !== guideOrder.length) {
		const seen = new Set<string>()
		const duplicates = guideOrder.filter((slug) => {
			if (seen.has(slug)) return true
			seen.add(slug)
			return false
		})
		throw new Error(
			`docs-nav.ts lists duplicate slug${duplicates.length === 1 ? '' : 's'}: ${duplicates.join(', ')}.`,
		)
	}

	const unlistedSlugs = guides
		.map((guide) => guide.slug)
		.filter((slug) => !orderIndexBySlug.has(slug))
	if (unlistedSlugs.length > 0) {
		throw new Error(
			`docs-nav.ts is missing nav (or unadvertisedDocSlugs) entr${unlistedSlugs.length === 1 ? 'y' : 'ies'} for: ${unlistedSlugs.join(', ')}.`,
		)
	}

	const guideSlugs = new Set(guides.map((guide) => guide.slug))
	const staleOrderEntries = guideOrder.filter((slug) => !guideSlugs.has(slug))
	if (staleOrderEntries.length > 0) {
		throw new Error(
			`docs-nav.ts lists entr${staleOrderEntries.length === 1 ? 'y' : 'ies'} with no matching guide: ${staleOrderEntries.join(', ')}.`,
		)
	}

	return guides.toSorted(
		(a, b) => orderIndexBySlug.get(a.slug)! - orderIndexBySlug.get(b.slug)!,
	)
}
