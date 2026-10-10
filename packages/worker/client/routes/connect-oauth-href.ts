import { type Handle } from 'remix/component'
import { readAppSession } from '#client/app-session-context.tsx'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'
import { organizationsWithSignupFallback } from '#universal/org-pages.ts'

/** Org integrations page for a connection that just finished OAuth. */
export function connectOauthConnectionHref(
	handle: Handle,
	providerKey: string,
) {
	const session = readAppSession(handle).session
	if (!session) return '/account'
	const organizations = organizationsWithSignupFallback({
		organizations: session.organizations ?? [],
		username: session.username,
	})
	const slug =
		organizations.find((org) => org.personal)?.slug ?? organizations[0]?.slug
	return slug
		? orgSectionRestPath(slug, 'integrations', providerKey)
		: '/account'
}
