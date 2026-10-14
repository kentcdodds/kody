import { defaultProviderMarkAliases } from './default-provider-mark-aliases.ts'

const knownProviderMarks = new Set<string>(
	Object.keys(defaultProviderMarkAliases),
)

export function isKnownProviderMark(slug: string): boolean {
	return knownProviderMarks.has(slug)
}

/**
 * OAuth app / connection provider id from a slug.
 *
 * Collapse into a parent family only when that family is a known provider mark
 * (`google-calendar` → `google`, `x-kodykoala` → `x`) so sibling accounts share
 * one OAuth app. Compound products whose first segment is not a mark
 * (`kody-exchange`, `cal-com`) keep the full slug so credential needs match
 * the provider packages declare.
 */
export function providerFromSlug(slug: string): string {
	const separator = slug.indexOf('-')
	if (separator === -1) return slug
	const family = slug.slice(0, separator)
	if (isKnownProviderMark(family)) return family
	return slug
}
