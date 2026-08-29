/**
 * Presentation grouping for the web `/guides` index (and its markdown /
 * JSON twins). Catalog order stays in `#worker/guides/guide-order.ts`; this
 * module only decides which platform guides sit in "Start here" versus
 * "More guides", and which path segments under `/guides/` are reserved for
 * index pages.
 *
 * Connection (provider) walkthroughs are not listed on `/guides` — they
 * live on the dedicated `/guides/connect` index.
 */

/** Fundamentals shown first under Work with Kody. */
export const guidesStartHereSlugs = [
	'what-is-kody',
	'how-kody-works',
	'kody-factory',
	'quick-example',
] as const

/**
 * Path segments under `/guides/` reserved for index pages. Catalog guides
 * must not use these slugs — they would collide with the dedicated routes.
 */
export const reservedGuideIndexSlugs = ['connect'] as const

export type GuidesStartHereSlug = (typeof guidesStartHereSlugs)[number]
export type ReservedGuideIndexSlug = (typeof reservedGuideIndexSlugs)[number]

export function isReservedGuideIndexSlug(slug: string): boolean {
	return (reservedGuideIndexSlugs as ReadonlyArray<string>).includes(slug)
}

export function isGuidesStartHereSlug(slug: string): boolean {
	return (guidesStartHereSlugs as ReadonlyArray<string>).includes(slug)
}
