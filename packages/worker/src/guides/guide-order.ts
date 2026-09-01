/**
 * Single source of truth for guide ordering. `#worker/guides/catalog.ts`
 * (web catalog, `codingGuideGet` schema description) and
 * `tools/build-guide-catalog-modules.ts` (generated metadata/full-catalog
 * modules) both sort their parsed guides through `sortGuidesByAuthoredOrder`
 * below, so the authored order can never silently drift between the two.
 *
 * The list preserves the catalog's authored order; presentation layers may
 * apply their own sorting (for example, the web index sorts providers by
 * display name). Adding a guide requires an entry here —
 * `sortGuidesByAuthoredOrder` throws immediately (surfacing in
 * `catalog.ts`'s module-scope `buildCatalog()` and in the generator) if a
 * parsed guide's slug is missing from this list, or if this list names a
 * slug with no matching guide.
 */
const guideOrder: ReadonlyArray<string> = [
	'what-is-kody',
	'how-kody-works',
	'kody-factory',
	'local-mcp-tunnels',
	'heavy-work-offload',
	'google-oauth',
	'quick-example',
	'first-win',
	'package-authoring',
	'package-lifecycle',
	'integration-bootstrap',
	'locked-gmail-drafts',
	'locked-mcp-server',
	'secret-backed-integration',
	'integration-backed-app-happy-path',
	'oauth',
	'account-secret-setup',
	'account-package-invocation-token-setup',
	'package-subscriptions',
	'platform-friction',
	'values',
	'openapi-integrations',
	'google',
	'github',
	'notion',
	'origin',
	'salesforce',
	'slack',
	'spotify',
	'discord',
]

/**
 * Sorts `guides` into the authored order declared in `guideOrder` above.
 * Throws on any mismatch between `guides` and `guideOrder` rather than
 * silently falling back to input order, so a guide added to `docs/guides/`
 * without a matching `guideOrder` entry (or vice versa) fails loudly instead
 * of quietly reordering `codingGuideGet`'s schema description or the web
 * catalog.
 */
export function sortGuidesByAuthoredOrder<T extends { slug: string }>(
	guides: ReadonlyArray<T>,
): ReadonlyArray<T> {
	const orderIndexBySlug = new Map(
		guideOrder.map((slug, index) => [slug, index]),
	)

	const unlistedSlugs = guides
		.map((guide) => guide.slug)
		.filter((slug) => !orderIndexBySlug.has(slug))
	if (unlistedSlugs.length > 0) {
		throw new Error(
			`guide-order.ts is missing guideOrder entr${unlistedSlugs.length === 1 ? 'y' : 'ies'} for: ${unlistedSlugs.join(', ')}.`,
		)
	}

	const guideSlugs = new Set(guides.map((guide) => guide.slug))
	const staleOrderEntries = guideOrder.filter((slug) => !guideSlugs.has(slug))
	if (staleOrderEntries.length > 0) {
		throw new Error(
			`guide-order.ts lists guideOrder entr${staleOrderEntries.length === 1 ? 'y' : 'ies'} with no matching guide: ${staleOrderEntries.join(', ')}.`,
		)
	}

	return guides.toSorted(
		(a, b) => orderIndexBySlug.get(a.slug)! - orderIndexBySlug.get(b.slug)!,
	)
}
