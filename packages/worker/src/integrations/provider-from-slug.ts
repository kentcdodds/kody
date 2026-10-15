import { defaultProviderMarkAliases } from './default-provider-mark-aliases.ts'

const knownProviderMarks = new Set<string>(
	Object.keys(defaultProviderMarkAliases),
)

/** Longest-first so `kody-exchange-work` prefers `kody-exchange` over nothing. */
const knownProviderMarksByLength = Object.keys(defaultProviderMarkAliases).sort(
	(left, right) => right.length - left.length || left.localeCompare(right),
)

export function isKnownProviderMark(slug: string): boolean {
	return knownProviderMarks.has(slug)
}

/**
 * Longest known mark that equals `slug` or is a hyphen-bounded prefix of it.
 */
export function longestKnownProviderMarkPrefix(slug: string): string | null {
	for (const mark of knownProviderMarksByLength) {
		if (slug === mark || slug.startsWith(`${mark}-`)) return mark
	}
	return null
}

/**
 * OAuth app / connection provider id from a slug.
 *
 * Collapse into a parent family only when that family is a known provider mark
 * (`google-calendar` → `google`, `x-kodykoala` → `x`) so sibling accounts share
 * one OAuth app. When the first segment is not a mark, keep the longest known
 * compound mark prefix (`kody-exchange-work` → `kody-exchange`, `cal-com` →
 * `cal-com`) so credential needs match the provider packages declare.
 * Otherwise keep the full slug.
 */
export function providerFromSlug(slug: string): string {
	const separator = slug.indexOf('-')
	if (separator === -1) return slug
	const family = slug.slice(0, separator)
	if (isKnownProviderMark(family)) return family
	return longestKnownProviderMarkPrefix(slug) ?? slug
}
