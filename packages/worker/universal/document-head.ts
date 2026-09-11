import { createMultiMatcher } from 'remix/route-pattern/match'
import { isAccountConnectionAgent } from '#universal/account-connections.ts'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { onboardingAgentLabel } from '#universal/onboarding-mcp-clients.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'
import { docHref, docsIntroSlug } from '#universal/docs-nav.ts'
import { publicOgPages, type PublicOgPageId } from '#universal/og-pages.ts'

const DEFAULT_DOCUMENT_TITLE = 'kody'
export const NOT_FOUND_DOCUMENT_TITLE = 'Not found'
export const INTERNAL_ERROR_DOCUMENT_TITLE = 'Something went wrong'

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

type DocumentHeadLink = {
	rel: string
	hrefPath: string
	type?: string
	title?: string
}

type DocumentHeadOg = {
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
		if (shell && 'notFound' in shell) {
			return titleOnly(NOT_FOUND_DOCUMENT_TITLE)
		}
		return titleOnly('Package')
	}
	const title = shell.listingId
		? `${shell.name} — Kody public package`
		: shell.name
	if (!shell.listingId) {
		return {
			title,
			canonicalPath: pathname,
		}
	}
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
 * `/docs` and `/docs/:slug` share one head: the introduction is canonical at
 * `/docs` itself, every other doc at its own `/docs/:slug`.
 */
function docDetailHead({
	loaderData,
}: DocumentHeadContext): DocumentHeadDescriptor {
	const doc = loaderData?.docDetail
	if (!doc?.ok) {
		return titleOnly('Docs')
	}
	const title =
		doc.slug === docsIntroSlug ? 'Kody Docs' : `${doc.title} — Kody Docs`
	return {
		title,
		description: doc.summary,
		canonicalPath: docHref(doc.slug),
		...(doc.ogImage
			? {
					og: {
						title,
						description: doc.summary,
						imagePath: routes.docDetailOgImage.href({ slug: doc.slug }),
					},
				}
			: {}),
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
	[routePattern(routes.accountBillingSuccess)]: titleOnly("You're in"),
	[routePattern(routes.accountUsage)]: titleOnly('Usage'),
	[routePattern(routes.accountWaiting)]: titleOnly('Waiting'),
	[routePattern(routes.accountConnections)]: titleOnly('Connections'),
	[routePattern(routes.accountConnectionNew)]: titleOnly('Add connection'),
	[routePattern(routes.accountConnectionNewAgent)]: ({ params }) => {
		const agent = params.agent
		return titleOnly(
			isAccountConnectionAgent(agent)
				? `Connect ${onboardingAgentLabel(agent)}`
				: 'Add connection',
		)
	},
	[routePattern(routes.accountShared)]: titleOnly('Shared packages'),
	[routePattern(routes.accountIntegrations)]: titleOnly('Integrations'),
	[routePattern(routes.accountOauthAppDetail)]: titleOnly('Integrations'),
	[routePattern(routes.accountIntegrationsApprove)]: titleOnly('Integrations'),
	[routePattern(routes.accountIntegrationDetail)]: titleOnly('Integrations'),
	[routePattern(routes.accountMcpServers)]: titleOnly('MCP servers'),
	[routePattern(routes.accountMcpServerNew)]: titleOnly('MCP servers'),
	[routePattern(routes.accountMcpServerDetail)]: titleOnly('MCP servers'),
	[routePattern(routes.communityPackageApprovePublish)]: titleOnly(
		'Approve package publish',
	),
	[routePattern(routes.communityPackageApproveChanges)]: titleOnly(
		'Approve shared package changes',
	),
	[routePattern(routes.accountPackageFiles)]: ({ loaderData }) => {
		const files = loaderData?.packageFiles
		return titleOnly(files?.ok ? `${files.title} files` : 'Package files')
	},
	[routePattern(routes.accountPasskeys)]: titleOnly('Passkeys'),
	[routePattern(routes.accountMcpOauthClients)]: titleOnly('MCP OAuth clients'),
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
	[routePattern(routes.accountWorkflows)]: titleOnly('Workflows'),
	[routePattern(routes.accountWorkflowDetail)]: titleOnly('Workflows'),
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
	[routePattern(routes.adminReservedUsernames)]: titleOnly(
		'Admin reserved usernames',
	),
	[routePattern(routes.adminFeatureFlags)]: titleOnly('Admin feature flags'),
	[routePattern(routes.adminBanners)]: titleOnly('Admin banners'),
	[routePattern(routes.adminPlatformIntegrations)]: titleOnly(
		'Admin platform integrations',
	),
	[routePattern(routes.adminPlatformIntegrationNew)]: titleOnly(
		'Admin platform integrations',
	),
	[routePattern(routes.adminPlatformIntegrationDetail)]: titleOnly(
		'Admin platform integrations',
	),
	[routePattern(routes.adminProviderMarks)]: titleOnly('Admin provider marks'),
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
	[routePattern(routes.docs)]: docDetailHead,
	[routePattern(routes.docsConnect)]: ({ pathname }) => ({
		title: 'Connect a provider — Kody Docs',
		description:
			'Verified walkthroughs for connecting Discord, GitHub, Google, Notion, Origin, Salesforce, Slack, or Spotify to Kody.',
		canonicalPath: pathname,
	}),
	[routePattern(routes.docDetail)]: docDetailHead,
	[routePattern(routes.community)]: publicPageHead(
		'community',
		'Public packages',
	),
	[routePattern(routes.communityDetail)]: communityListingHead,
	[routePattern(routes.communityPackage)]: communityListingHead,
	[routePattern(routes.communityPackageSettings)]: ({
		loaderData,
		pathname,
	}) => {
		const shell = loaderData?.communityDetailShell
		if (!shell?.ok) {
			if (shell && 'notFound' in shell) {
				return titleOnly(NOT_FOUND_DOCUMENT_TITLE)
			}
			return titleOnly('Package settings')
		}
		return {
			title: `${shell.name} settings`,
			canonicalPath: pathname,
		}
	},
	[routePattern(routes.communityDetailFiles)]: ({ loaderData, pathname }) => {
		const files = loaderData?.packageFiles
		if (!files?.ok) return titleOnly('Package files')
		return {
			title: `${files.title} files`,
			canonicalPath: pathname,
		}
	},
	[routePattern(routes.communityPackageFiles)]: ({ loaderData, pathname }) => {
		const files = loaderData?.packageFiles
		if (!files?.ok) return titleOnly('Package files')
		return {
			title: `${files.title} files`,
			canonicalPath: pathname,
		}
	},
	[routePattern(routes.communityPackageTree)]: ({ loaderData, pathname }) => {
		const files = loaderData?.packageFiles
		if (!files?.ok) return titleOnly('Package files')
		return {
			title: `${files.title} files`,
			canonicalPath: pathname,
		}
	},
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
	[routePattern(routes.notFoundPage)]: titleOnly(NOT_FOUND_DOCUMENT_TITLE),
	[routePattern(routes.internalErrorPage)]: titleOnly(
		INTERNAL_ERROR_DOCUMENT_TITLE,
	),
	[routePattern(routes.login)]: publicPageHead('login', DEFAULT_DOCUMENT_TITLE),
	[routePattern(routes.signup)]: publicPageHead(
		'signup',
		DEFAULT_DOCUMENT_TITLE,
	),
	[routePattern(routes.onboarding)]: publicPageHead(
		'onboarding',
		'Get started',
	),
	[routePattern(routes.onboardingStep1)]: publicPageHead(
		'onboarding',
		'Get started',
	),
	[routePattern(routes.onboardingStep1Agent)]: publicPageHead(
		'onboarding',
		'Get started',
	),
	[routePattern(routes.onboardingStep2)]: publicPageHead(
		'onboarding',
		'Get started',
	),
	[routePattern(routes.onboardingStep2Service)]: publicPageHead(
		'onboarding',
		'Get started',
	),
	[routePattern(routes.onboardingStep3)]: publicPageHead(
		'onboarding',
		'Get started',
	),
	[routePattern(routes.onboardingStep3Agent)]: publicPageHead(
		'onboarding',
		'Get started',
	),
	[routePattern(routes.pendingVerification)]: titleOnly('Verify your email'),
	[routePattern(routes.pricing)]: publicPageHead('pricing', 'Pricing'),
	[routePattern(routes.faq)]: publicPageHead('faq', 'FAQ'),
	[routePattern(routes.support)]: publicPageHead('support', 'Support'),
	[routePattern(routes.privacy)]: publicPageHead('privacy', 'Privacy'),
	[routePattern(routes.terms)]: publicPageHead('terms', 'Terms'),
	[routePattern(routes.discord)]: publicPageHead('discord', 'Discord'),
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
	[routePattern(routes.verifyEmailClaimRelease)]: ({ loaderData }) => {
		const verification = loaderData?.emailVerification
		return titleOnly(verification?.ok ? 'Email released' : 'Release email')
	},
	[routePattern(routes.unsubscribeTips)]: ({ loaderData }) => {
		const unsubscribe = loaderData?.tipsUnsubscribe
		return titleOnly(
			unsubscribe?.ok ? 'Unsubscribed from tips' : 'Unsubscribe from tips',
		)
	},
	[routePattern(routes.connectOauth)]: ({ loaderData }) => {
		const provider = loaderData?.connectOauth?.provider?.trim()
		return titleOnly(provider ? `Connect ${provider}` : 'Connect an account')
	},
	[routePattern(routes.connectSecrets)]: titleOnly('Allow secret hosts'),
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
