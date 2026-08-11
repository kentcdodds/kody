import { createMultiMatcher } from 'remix/route-pattern/match'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'
import { publicOgPages, type PublicOgPageId } from '#universal/og-pages.ts'

export const DEFAULT_DOCUMENT_TITLE = 'kody'
export const NOT_FOUND_DOCUMENT_TITLE = 'Not found'

/** Stable marker so SPA navigation can upsert/remove managed head tags. */
export const DOCUMENT_HEAD_ATTR = 'data-kody-head'

/**
 * Meta tag carrying the canonical origin the server rendered head URLs with
 * (`getCanonicalAppBaseUrl`). SPA navigations read it so canonical/OG URLs
 * keep pointing at the canonical domain when the page is dual-served from a
 * legacy host, instead of reverting to `window.location.origin`.
 */
export const CANONICAL_ORIGIN_META_NAME = 'kody:canonical-origin'

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
	description?: string
	canonicalPath?: string
	og?: DocumentHeadOg
	links?: Array<DocumentHeadLink>
}

export type ResolvedDocumentHead = {
	title: string
	description?: string
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

/**
 * Shared by the canonical `/@owner/kody-id` URL and the listing-uuid URL that
 * redirects to it, so a listing describes itself identically either way.
 */
function communityListingHead({
	loaderData,
	pathname,
}: DocumentHeadContext): DocumentHeadDescriptor {
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
	[routePattern(routes.home)]: publicPageHead('home', DEFAULT_DOCUMENT_TITLE),
	[routePattern(routes.account)]: titleOnly('Account'),
	[routePattern(routes.accountBilling)]: titleOnly('Billing'),
	[routePattern(routes.accountUsage)]: titleOnly('Usage'),
	[routePattern(routes.accountIntegrations)]: titleOnly('Integrations'),
	[routePattern(routes.accountOauthAppDetail)]: titleOnly('Integrations'),
	[routePattern(routes.accountIntegrationDetail)]: titleOnly('Integrations'),
	[routePattern(routes.accountMcpServers)]: titleOnly('MCP servers'),
	[routePattern(routes.accountMcpServerNew)]: titleOnly('MCP servers'),
	[routePattern(routes.accountMcpServerDetail)]: titleOnly('MCP servers'),
	[routePattern(routes.accountPackageInvocationTokens)]: titleOnly(
		'Package invocation tokens',
	),
	[routePattern(routes.accountPackageInvocationTokenNew)]: titleOnly(
		'Package invocation tokens',
	),
	[routePattern(routes.accountPackageInvocationTokenDetail)]: titleOnly(
		'Package invocation tokens',
	),
	[routePattern(routes.accountPackages)]: titleOnly('Packages'),
	[routePattern(routes.accountPackageDetail)]: titleOnly('Packages'),
	[routePattern(routes.accountStars)]: titleOnly('Starred packages'),
	[routePattern(routes.accountPasskeys)]: titleOnly('Passkeys'),
	[routePattern(routes.accountRemoteConnectors)]:
		titleOnly('Remote connectors'),
	[routePattern(routes.accountRemoteConnectorNew)]:
		titleOnly('Remote connectors'),
	[routePattern(routes.accountRemoteConnectorDetail)]:
		titleOnly('Remote connectors'),
	[routePattern(routes.accountSecrets)]: titleOnly('Secrets'),
	[routePattern(routes.accountSecretNew)]: titleOnly('Secrets'),
	[routePattern(routes.accountSecretsApprove)]: titleOnly('Secrets'),
	[routePattern(routes.accountSecretUserDetail)]: titleOnly('Secrets'),
	[routePattern(routes.accountSecretPackageDetail)]: titleOnly('Secrets'),
	[routePattern(routes.accountSecretSessionDetail)]: titleOnly('Secrets'),
	[routePattern(routes.accountValues)]: titleOnly('Values'),
	[routePattern(routes.accountValueNew)]: titleOnly('Values'),
	[routePattern(routes.accountValueDetail)]: titleOnly('Values'),
	[routePattern(routes.accountJobs)]: titleOnly('Jobs'),
	[routePattern(routes.accountJobDetail)]: titleOnly('Jobs'),
	[routePattern(routes.accountActivity)]: titleOnly('Activity'),
	[routePattern(routes.accountActivityDetail)]: titleOnly('Activity'),
	[routePattern(routes.accountMemories)]: titleOnly('Memories'),
	[routePattern(routes.accountMemoryDetail)]: titleOnly('Memories'),
	[routePattern(routes.accountEmail)]: titleOnly('Email inbox'),
	[routePattern(routes.accountEmailDetail)]: titleOnly('Email inbox'),
	[routePattern(routes.accountTwoFactor)]: titleOnly(
		'Two-factor authentication',
	),
	[routePattern(routes.admin)]: titleOnly('Admin users'),
	[routePattern(routes.adminUsers)]: titleOnly('Admin users'),
	[routePattern(routes.adminUserDetail)]: titleOnly('Admin users'),
	[routePattern(routes.adminInvites)]: titleOnly('Admin invites'),
	[routePattern(routes.adminFeatureFlags)]: titleOnly('Admin feature flags'),
	[routePattern(routes.adminPlatformIntegrations)]: titleOnly(
		'Admin platform integrations',
	),
	[routePattern(routes.adminPlatformIntegrationNew)]: titleOnly(
		'Admin platform integrations',
	),
	[routePattern(routes.adminPlatformIntegrationDetail)]: titleOnly(
		'Admin platform integrations',
	),
	[routePattern(routes.adminCodemods)]: titleOnly('Admin codemods'),
	[routePattern(routes.adminRoles)]: titleOnly('Admin roles'),
	[routePattern(routes.adminCommunityReports)]: titleOnly('Community reports'),
	[routePattern(routes.adminInsights)]: titleOnly('Admin insights'),
	[routePattern(routes.adminPlatformFeedback)]: titleOnly(
		'Admin platform feedback',
	),
	[routePattern(routes.adminSystemEmail)]: titleOnly('Admin system email'),
	[routePattern(routes.blog)]: publicPageHead('blog', 'Blog', {
		links: [
			{
				rel: 'alternate',
				type: 'application/rss+xml',
				title: 'Kody Blog RSS',
				hrefPath: '/blog/rss.xml',
			},
		],
	}),
	[routePattern(routes.blogPost)]: ({ loaderData, pathname }) => {
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
	[routePattern(routes.guides)]: titleOnly('Guides'),
	[routePattern(routes.guideDetail)]: ({ loaderData }) => {
		const guide = loaderData?.guideDetail
		if (!guide?.ok) {
			return titleOnly('Guides')
		}
		return titleOnly(guide.title)
	},
	[routePattern(routes.community)]: publicPageHead(
		'community',
		'Community packages',
	),
	[routePattern(routes.communityDetail)]: communityListingHead,
	[routePattern(routes.communityPackage)]: communityListingHead,
	[routePattern(routes.profile)]: ({ loaderData, params, pathname }) => {
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
	[routePattern(routes.timeline)]: titleOnly('Timeline'),
	[routePattern(routes.login)]: publicPageHead('login', DEFAULT_DOCUMENT_TITLE),
	[routePattern(routes.signup)]: publicPageHead(
		'signup',
		DEFAULT_DOCUMENT_TITLE,
	),
	[routePattern(routes.onboarding)]: publicPageHead(
		'onboarding',
		'Get started',
	),
	[routePattern(routes.pendingVerification)]: titleOnly('Verify your email'),
	[routePattern(routes.pricing)]: publicPageHead('pricing', 'Pricing'),
	[routePattern(routes.privacy)]: publicPageHead('privacy', 'Privacy'),
	[routePattern(routes.terms)]: publicPageHead('terms', 'Terms'),
	[routePattern(routes.resetPassword)]: publicPageHead(
		'reset-password',
		'Reset password',
	),
	[routePattern(routes.verify)]: titleOnly('Two-factor authentication'),
	[routePattern(routes.verifyEmail)]: ({ loaderData }) => {
		const verification = loaderData?.emailVerification
		return titleOnly(verification?.ok ? 'Email verified' : 'Verify email')
	},
	[routePattern(routes.verifyEmailChange)]: ({ loaderData }) => {
		const verification = loaderData?.emailVerification
		return titleOnly(verification?.ok ? 'Email changed' : 'Verify email change')
	},
	[routePattern(routes.connectOauth)]: titleOnly('Connect OAuth'),
	[oauthPaths.authorize]: titleOnly('Authorize access'),
	[oauthPaths.callback]: titleOnly('OAuth callback'),
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
	if (!match) {
		return titleOnly(NOT_FOUND_DOCUMENT_TITLE)
	}

	const resolver = match.data
	const descriptor =
		typeof resolver === 'function'
			? resolver({
					pathname,
					params: match.params,
					loaderData,
				})
			: resolver

	const description = descriptor.description ?? descriptor.og?.description
	if (description === undefined) return descriptor
	return { ...descriptor, description }
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
		description: descriptor.description,
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
