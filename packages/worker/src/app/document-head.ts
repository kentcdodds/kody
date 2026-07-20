import { createMultiMatcher } from 'remix/route-pattern/match'
import { type AppLoaderData } from '#app/loader-data.ts'
import { publicOgPages, type PublicOgPageId } from '#worker/og/pages.ts'

export const DEFAULT_DOCUMENT_TITLE = 'kody'
export const NOT_FOUND_DOCUMENT_TITLE = 'Not found'

/** Stable marker so SPA navigation can upsert/remove managed head tags. */
export const DOCUMENT_HEAD_ATTR = 'data-kody-head'

const documentHeadOrigin = 'https://kody.local'

export type DocumentHeadLink = {
	rel: string
	hrefPath: string
	type?: string
	title?: string
}

export type DocumentHeadOg = {
	title: string
	description: string
	imagePath: string
}

/**
 * Route-relative head descriptor. Paths stay origin-relative so the same
 * registry works for SSR (absolute URLs) and SPA updates (`location.origin`).
 */
export type DocumentHeadDescriptor = {
	title: string
	canonicalPath?: string
	og?: DocumentHeadOg
	links?: Array<DocumentHeadLink>
}

export type ResolvedDocumentHead = {
	title: string
	canonicalUrl?: string
	og?: {
		title: string
		description: string
		imageUrl: string
	}
	links?: Array<{
		rel: string
		href: string
		type?: string
		title?: string
	}>
}

type DocumentHeadContext = {
	pathname: string
	params: Record<string, string | undefined>
	loaderData?: Partial<AppLoaderData>
}

type DocumentHeadResolver =
	| DocumentHeadDescriptor
	| ((context: DocumentHeadContext) => DocumentHeadDescriptor)

function truncateText(text: string, maxLength: number) {
	const trimmed = text.trim()
	if (trimmed.length <= maxLength) return trimmed
	return `${trimmed.slice(0, maxLength - 1)}…`
}

function titleOnly(title: string): DocumentHeadDescriptor {
	return { title }
}

function publicPageHead(
	pageId: PublicOgPageId,
	title: string,
	extra?: Pick<DocumentHeadDescriptor, 'links'>,
): DocumentHeadDescriptor {
	const page = publicOgPages[pageId]
	return {
		title,
		canonicalPath: page.path,
		og: {
			title: page.ogTitle,
			description: page.ogDescription,
			imagePath: `/og/${pageId}.png`,
		},
		links: extra?.links,
	}
}

/**
 * Single registry for document head metadata (title, OG/Twitter, canonical,
 * alternate links). SSR and the client router both resolve from here so SPA
 * navigations keep `<head>` in sync without per-route wiring.
 */
const routeDocumentHeads = {
	'/': publicPageHead('home', DEFAULT_DOCUMENT_TITLE),
	'/account': titleOnly('Account'),
	'/account/billing': titleOnly('Billing'),
	'/account/integrations': titleOnly('Integrations'),
	'/account/mcp-servers': titleOnly('MCP servers'),
	'/account/package-invocation-tokens': titleOnly('Package invocation tokens'),
	'/account/package-invocation-tokens/new': titleOnly(
		'Package invocation tokens',
	),
	'/account/package-invocation-tokens/:tokenId': titleOnly(
		'Package invocation tokens',
	),
	'/account/packages': titleOnly('Packages'),
	'/account/packages/:packageId': titleOnly('Packages'),
	'/account/stars': titleOnly('Starred packages'),
	'/account/passkeys': titleOnly('Passkeys'),
	'/account/remote-connectors': titleOnly('Remote connectors'),
	'/account/secrets': titleOnly('Secrets'),
	'/account/secrets/new': titleOnly('Secrets'),
	'/account/secrets/approve': titleOnly('Secrets'),
	'/account/secrets/user/:secretName': titleOnly('Secrets'),
	'/account/secrets/package/:packageId/:secretName': titleOnly('Secrets'),
	'/account/secrets/session/:sessionId/:secretName': titleOnly('Secrets'),
	'/account/two-factor': titleOnly('Two-factor authentication'),
	'/admin': titleOnly('Admin users'),
	'/admin/users': titleOnly('Admin users'),
	'/admin/invites': titleOnly('Admin invites'),
	'/admin/feature-flags': titleOnly('Admin feature flags'),
	'/admin/roles': titleOnly('Admin roles'),
	'/admin/community-reports': titleOnly('Community reports'),
	'/admin/insights': titleOnly('Admin insights'),
	'/admin/platform-feedback': titleOnly('Admin platform feedback'),
	'/admin/system-email': titleOnly('Admin system email'),
	'/blog': publicPageHead('blog', 'Blog', {
		links: [
			{
				rel: 'alternate',
				type: 'application/rss+xml',
				title: 'Kody Blog RSS',
				hrefPath: '/blog/rss.xml',
			},
		],
	}),
	'/blog/:slug': ({ loaderData, pathname }) => {
		const post = loaderData?.blogPost
		if (!post?.ok) {
			return titleOnly('Blog')
		}
		const title = `${post.title} — Kody Blog`
		return {
			title,
			canonicalPath: pathname,
			og: {
				title,
				description: post.description,
				imagePath: `/blog/${post.slug}/og.png`,
			},
		}
	},
	'/community': publicPageHead('community', 'Community packages'),
	'/community/:listingId': ({ loaderData, pathname }) => {
		const shell = loaderData?.communityDetailShell
		if (!shell?.ok) {
			return titleOnly('Community packages')
		}
		const title = `${shell.name} — Kody community package`
		return {
			title,
			canonicalPath: pathname,
			og: {
				title,
				description: truncateText(shell.description, 200),
				imagePath: `/community/${shell.listingId}/og.png`,
			},
		}
	},
	'/@:username': ({ loaderData, params, pathname }) => {
		const shell = loaderData?.profileShell
		if (shell && !shell.ok) {
			return titleOnly('Profile unavailable')
		}
		if (!shell?.ok) {
			const username = params.username
			return titleOnly(username ? `@${username}` : 'Profile')
		}

		const title = shell.displayName
		if (shell.visibility !== 'public') {
			return titleOnly(title)
		}

		const ogTitle = `${shell.displayName} (@${shell.username}) — Kody`
		const ogDescription =
			shell.bio == null || shell.bio.trim() === ''
				? 'Community profile on Kody.'
				: truncateText(shell.bio, 200)
		return {
			title,
			canonicalPath: pathname,
			og: {
				title: ogTitle,
				description: ogDescription,
				imagePath: `/profiles/${shell.username}/og.png`,
			},
		}
	},
	'/timeline': titleOnly('Timeline'),
	'/login': publicPageHead('login', DEFAULT_DOCUMENT_TITLE),
	'/signup': publicPageHead('signup', DEFAULT_DOCUMENT_TITLE),
	'/onboarding': publicPageHead('onboarding', 'Get started'),
	'/pending-verification': titleOnly('Verify your email'),
	'/privacy': publicPageHead('privacy', 'Privacy'),
	'/reset-password': publicPageHead('reset-password', 'Reset password'),
	'/verify': titleOnly('Two-factor authentication'),
	'/verify-email': ({ loaderData }) => {
		const verification = loaderData?.emailVerification
		return titleOnly(verification?.ok ? 'Email verified' : 'Verify email')
	},
	'/verify-email-change': ({ loaderData }) => {
		const verification = loaderData?.emailVerification
		return titleOnly(verification?.ok ? 'Email changed' : 'Verify email change')
	},
	'/connect/oauth': titleOnly('Connect OAuth'),
	'/oauth/authorize': titleOnly('Authorize access'),
	'/oauth/callback': titleOnly('OAuth callback'),
} as const satisfies Record<string, DocumentHeadResolver>

const documentHeadMatcher = (() => {
	const matcher = createMultiMatcher<DocumentHeadResolver>()
	for (const [pattern, resolver] of Object.entries(routeDocumentHeads)) {
		matcher.add(pattern, resolver)
	}
	return matcher
})()

export function resolveDocumentHead(
	pathname: string,
	loaderData?: Partial<AppLoaderData>,
): DocumentHeadDescriptor {
	const match = documentHeadMatcher.match(new URL(pathname, documentHeadOrigin))
	if (!match) return titleOnly(NOT_FOUND_DOCUMENT_TITLE)

	const resolver = match.data
	if (typeof resolver === 'function') {
		return resolver({
			pathname,
			params: match.params,
			loaderData,
		})
	}
	return resolver
}

export function resolveDocumentTitle(
	pathname: string,
	loaderData?: Partial<AppLoaderData>,
): string {
	return resolveDocumentHead(pathname, loaderData).title
}

export function absolutizeDocumentHead(
	descriptor: DocumentHeadDescriptor,
	origin: string,
): ResolvedDocumentHead {
	const normalizedOrigin = origin.replace(/\/$/, '')
	const toAbsolute = (path: string) =>
		path.startsWith('http://') || path.startsWith('https://')
			? path
			: `${normalizedOrigin}${path.startsWith('/') ? path : `/${path}`}`

	return {
		title: descriptor.title,
		canonicalUrl: descriptor.canonicalPath
			? toAbsolute(descriptor.canonicalPath)
			: undefined,
		og: descriptor.og
			? {
					title: descriptor.og.title,
					description: descriptor.og.description,
					imageUrl: toAbsolute(descriptor.og.imagePath),
				}
			: undefined,
		links: descriptor.links?.map((link) => ({
			rel: link.rel,
			href: toAbsolute(link.hrefPath),
			type: link.type,
			title: link.title,
		})),
	}
}
