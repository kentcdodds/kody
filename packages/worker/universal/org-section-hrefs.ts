import { createHref } from 'remix/route-pattern/href'
import {
	orgResourcePath,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'

/**
 * One path segment, with Remix's dot encoding (`%2E`), so a name like
 * `google.personal` survives route matching.
 */
function encodedPathSegment(segment: string) {
	return createHref('/:segment', { segment }).slice(1)
}

export function orgSectionRestPath(
	slug: string,
	section: OrgOwnedAccountSection,
	rest = '',
) {
	const suffix = rest
		.split('/')
		.filter(Boolean)
		.map((segment) => encodedPathSegment(segment))
		.join('/')
	return orgResourcePath(slug, section, suffix)
}
