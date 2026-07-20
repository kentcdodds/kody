import { createMultiMatcher } from 'remix/route-pattern/match'
import { type AppLoaderData } from '#app/loader-data.ts'

export const DEFAULT_DOCUMENT_TITLE = 'kody'
export const NOT_FOUND_DOCUMENT_TITLE = 'Not found'

const documentTitleOrigin = 'https://kody.local'

type DocumentTitleContext = {
	params: Record<string, string | undefined>
	loaderData?: Partial<AppLoaderData>
}

type DocumentTitleResolver =
	| string
	| ((context: DocumentTitleContext) => string)

/**
 * Single registry of document titles for app routes. The client router applies
 * the resolved title on every SPA navigation; SSR can use the same helper so
 * titles stay consistent without per-route `document.title` updates.
 */
const routeDocumentTitles = {
	'/': DEFAULT_DOCUMENT_TITLE,
	'/account': 'Account',
	'/account/billing': 'Billing',
	'/account/integrations': 'Integrations',
	'/account/mcp-servers': 'MCP servers',
	'/account/package-invocation-tokens': 'Package invocation tokens',
	'/account/package-invocation-tokens/new': 'Package invocation tokens',
	'/account/package-invocation-tokens/:tokenId': 'Package invocation tokens',
	'/account/packages': 'Packages',
	'/account/packages/:packageId': 'Packages',
	'/account/stars': 'Starred packages',
	'/account/passkeys': 'Passkeys',
	'/account/remote-connectors': 'Remote connectors',
	'/account/secrets': 'Secrets',
	'/account/secrets/new': 'Secrets',
	'/account/secrets/approve': 'Secrets',
	'/account/secrets/user/:secretName': 'Secrets',
	'/account/secrets/package/:packageId/:secretName': 'Secrets',
	'/account/secrets/session/:sessionId/:secretName': 'Secrets',
	'/account/two-factor': 'Two-factor authentication',
	'/admin': 'Admin users',
	'/admin/users': 'Admin users',
	'/admin/invites': 'Admin invites',
	'/admin/feature-flags': 'Admin feature flags',
	'/admin/roles': 'Admin roles',
	'/admin/community-reports': 'Community reports',
	'/admin/insights': 'Admin insights',
	'/admin/platform-feedback': 'Admin platform feedback',
	'/admin/system-email': 'Admin system email',
	'/blog': 'Blog',
	'/blog/:slug': ({ loaderData }) => {
		const post = loaderData?.blogPost
		if (post?.ok) return `${post.title} — Kody Blog`
		return 'Blog'
	},
	'/community': 'Community packages',
	'/community/:listingId': ({ loaderData }) => {
		const shell = loaderData?.communityDetailShell
		if (shell?.ok && shell.name) {
			return `${shell.name} — Kody community package`
		}
		return 'Community packages'
	},
	'/@:username': ({ loaderData, params }) => {
		const shell = loaderData?.profileShell
		if (shell && !shell.ok) return 'Profile unavailable'
		if (shell?.ok) return shell.displayName
		const username = params.username
		return username ? `@${username}` : 'Profile'
	},
	'/timeline': 'Timeline',
	'/login': DEFAULT_DOCUMENT_TITLE,
	'/signup': DEFAULT_DOCUMENT_TITLE,
	'/onboarding': 'Get started',
	'/pending-verification': 'Verify your email',
	'/privacy': 'Privacy',
	'/reset-password': 'Reset password',
	'/verify': 'Two-factor authentication',
	'/verify-email': ({ loaderData }) => {
		const verification = loaderData?.emailVerification
		if (verification?.ok) return 'Email verified'
		return 'Verify email'
	},
	'/verify-email-change': ({ loaderData }) => {
		const verification = loaderData?.emailVerification
		if (verification?.ok) return 'Email changed'
		return 'Verify email change'
	},
	'/connect/oauth': 'Connect OAuth',
	'/oauth/authorize': 'Authorize access',
	'/oauth/callback': 'OAuth callback',
} as const satisfies Record<string, DocumentTitleResolver>

const documentTitleMatcher = (() => {
	const matcher = createMultiMatcher<DocumentTitleResolver>()
	for (const [pattern, resolver] of Object.entries(routeDocumentTitles)) {
		matcher.add(pattern, resolver)
	}
	return matcher
})()

export function resolveDocumentTitle(
	pathname: string,
	loaderData?: Partial<AppLoaderData>,
): string {
	const match = documentTitleMatcher.match(
		new URL(pathname, documentTitleOrigin),
	)
	if (!match) return NOT_FOUND_DOCUMENT_TITLE

	const resolver = match.data
	if (typeof resolver === 'string') return resolver
	return resolver({
		params: match.params,
		loaderData,
	})
}
