import { acquisitionPageSummaries } from '#universal/acquisition/metadata.ts'
import { createMultiMatcher } from 'remix/route-pattern/match'
import { isAccountConnectionAgent } from '#universal/account-connections.ts'
import { type AppLoaderData } from '#universal/loader-data.ts'
import { onboardingAgentLabel } from '#universal/onboarding-mcp-clients.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'
import { docHref, docsIntroSlug } from '#universal/docs-nav.ts'
import {
	homeOgImagePath,
	readHomeOgVariant,
	applyHomeOgVariant,
} from '#universal/home-og-variants.ts'
import { publicOgPages, type PublicOgPageId } from '#universal/og-pages.ts'

export const DEFAULT_DOCUMENT_TITLE = 'Kody'
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
	search: string
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

/**
 * `/?og=<key>` shares a variant card. The canonical URL stays `/` so the
 * unfurl target does not keep the query. Unknown keys keep the default home
 * card. The browser strips `og` after load; crawlers only see this HTML.
 */
function homeDocumentHead(
	context: DocumentHeadContext,
): DocumentHeadDescriptor {
	const head = publicPageHead('home', publicOgPages.home.ogTitle)
	const variant = readHomeOgVariant(context.search)
	if (!variant || !head.og) return head
	const page = applyHomeOgVariant(publicOgPages.home, variant)
	return {
		...head,
		og: {
			title: page.ogTitle,
			description: page.ogDescription,
			imagePath: homeOgImagePath(variant.id),
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

function featurePageHead(
	pageId: PublicOgPageId,
	title: string,
): DocumentHeadDescriptor {
	return {
		...publicPageHead(pageId, title, {
			links: [{ rel: 'stylesheet', hrefPath: '/feature-pages.css' }],
		}),
		description: publicOgPages[pageId].ogDescription,
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
	[routePattern(routes.home)]: homeDocumentHead,
	[routePattern(routes.account)]: titleOnly('Profile'),
	[routePattern(routes.accountSecurity)]: titleOnly('Security'),
	[routePattern(routes.accountData)]: titleOnly('Data & deletion'),
	[routePattern(routes.accountOrganizations)]: titleOnly('Organizations'),
	[routePattern(routes.orgBilling)]: titleOnly('Billing'),
	[routePattern(routes.orgBillingSuccess)]: titleOnly("You're in"),
	[routePattern(routes.accountUsage)]: titleOnly('Usage'),
	[routePattern(routes.accountExperiments)]: titleOnly('Experiments'),
	[routePattern(routes.communityPackageApprovePublish)]: titleOnly(
		'Approve package publish',
	),
	[routePattern(routes.accountPackageFiles)]: ({ loaderData }) => {
		const files = loaderData?.packageFiles
		return titleOnly(files?.ok ? `${files.title} files` : 'Package files')
	},
	[routePattern(routes.accountPasskeys)]: titleOnly('Passkeys'),
	[routePattern(routes.accountMcpOauthClients)]: titleOnly('MCP OAuth clients'),
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
	[routePattern(routes.features)]: featurePageHead(
		'features',
		'Kody features for your AI agents | Kody',
	),
	[routePattern(routes.featureMemory)]: featurePageHead(
		'feature-memory',
		'Shared memory for your AI agents | Kody',
	),
	[routePattern(routes.featureSecrets)]: featurePageHead(
		'feature-secrets',
		'API secrets for your AI agents | Kody',
	),
	[routePattern(routes.featurePackages)]: featurePageHead(
		'feature-packages',
		'Reusable packages for your AI agents | Kody',
	),
	[routePattern(routes.featureTriggers)]: featurePageHead(
		'feature-triggers',
		'Triggers and automation for your AI agents | Kody',
	),
	[routePattern(routes.featureIntegrations)]: featurePageHead(
		'feature-integrations',
		'Service connections for your AI agents | Kody',
	),
	[routePattern(routes.featureApps)]: featurePageHead(
		'feature-apps',
		'Package apps for your AI agents | Kody',
	),
	[routePattern(routes.business)]: publicPageHead(
		'business',
		'AI Agent Cloud for Business and Agencies | Kody',
	),
	[routePattern(routes.pricing)]: publicPageHead('pricing', 'Pricing'),
	[routePattern(routes.faq)]: publicPageHead('faq', 'FAQ'),
	[routePattern(routes.n8nAlternatives)]: acquisitionHead,
	[routePattern(routes.mcpGateway)]: acquisitionHead,
	[routePattern(routes.sharedMemory)]: acquisitionHead,
	[routePattern(routes.gmail)]: acquisitionHead,
	[routePattern(routes.customTools)]: acquisitionHead,
	[routePattern(routes.composioAlternatives)]: acquisitionHead,
	[routePattern(routes.slack)]: acquisitionHead,
	[routePattern(routes.scheduledWorkflows)]: acquisitionHead,
	[routePattern(routes.claudeIntegrations)]: acquisitionHead,
	[routePattern(routes.useCases)]: acquisitionHead,
	[routePattern(routes.automation)]: acquisitionHead,
	[routePattern(routes.caseStudies)]: publicPageHead(
		'case-studies',
		'Case studies',
	),
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
	[routePattern(routes.verifyEmailDestination)]: ({ loaderData }) => {
		const verification = loaderData?.emailVerification
		return titleOnly(
			verification?.ok
				? 'Email destination verified'
				: 'Verify email destination',
		)
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
	[routePattern(routes.connectSecretSet)]: titleOnly('Set secret'),
	[routePattern(routes.connectWebhookApply)]: titleOnly(
		'Approve webhook apply destination',
	),
	[oauthPaths.authorize]: titleOnly('Authorize access'),
	[oauthPaths.callback]: titleOnly('OAuth callback'),
} as const satisfies Record<string, DocumentHeadResolver>

const orgDocumentHeads: Record<string, DocumentHeadResolver> = {
	[routePattern(routes.orgActivity)]: titleOnly('Activity'),
	[routePattern(routes.orgConnections)]: ({ pathname }) => {
		const rest = pathname.split('/-/connections/')[1]?.replace(/\/$/, '') ?? ''
		if (rest === 'new') return titleOnly('Add connection')
		if (rest.startsWith('new/')) {
			const agent = rest.slice('new/'.length).split('/')[0] ?? ''
			let decoded = agent
			try {
				decoded = decodeURIComponent(agent)
			} catch {
				decoded = agent
			}
			return titleOnly(
				isAccountConnectionAgent(decoded)
					? `Connect ${onboardingAgentLabel(decoded)}`
					: 'Add connection',
			)
		}
		return titleOnly('Connections')
	},
	[routePattern(routes.orgEmail)]: titleOnly('Email inbox'),
	[routePattern(routes.orgIntegrations)]: titleOnly('Integrations'),
	[routePattern(routes.orgJobs)]: titleOnly('Jobs'),
	[routePattern(routes.orgMcpServers)]: titleOnly('MCP servers'),
	[routePattern(routes.orgMemories)]: titleOnly('Memories'),
	[routePattern(routes.orgPackages)]: titleOnly('Repositories'),
	[routePattern(routes.orgSecretProviders)]: titleOnly('Secret providers'),
	[routePattern(routes.orgSecrets)]: titleOnly('Secrets'),
	[routePattern(routes.orgValues)]: titleOnly('Values'),
	[routePattern(routes.orgWaiting)]: titleOnly('Waiting'),
	[routePattern(routes.orgWebhooks)]: titleOnly('Webhooks'),
	[routePattern(routes.orgWorkflows)]: titleOnly('Workflows'),
	// Static `/-/` outranks `/@:username/:kodyId/settings` (kodyId would be `-`).
	[routePattern(routes.orgSettings)]: titleOnly('Settings'),
	[routePattern(routes.orgMembers)]: titleOnly('Members'),
	[routePattern(routes.orgTeams)]: titleOnly('Teams'),
	[routePattern(routes.orgGrants)]: titleOnly('Grants'),
	[routePattern(routes.orgCollaborators)]: titleOnly('Collaborators'),
	[routePattern(routes.accountOrganizationsNew)]: titleOnly(
		'Create organization',
	),
}

const documentHeadMatcher = (() => {
	const matcher = createMultiMatcher<DocumentHeadResolver>()
	for (const [pattern, resolver] of Object.entries({
		...routeDocumentHeads,
		...orgDocumentHeads,
	})) {
		matcher.add(pattern, resolver)
	}
	return matcher
})()

export function resolveDocumentHead(
	pathname: string,
	loaderData?: Partial<AppLoaderData>,
	search = '',
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
					search,
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

function acquisitionHead({
	pathname,
}: {
	pathname: string
}): DocumentHeadDescriptor {
	const page = acquisitionPageSummaries.find((entry) => entry.path === pathname)
	if (!page) return { title: NOT_FOUND_DOCUMENT_TITLE }
	const title = `${page.title} | Kody`
	return {
		title,
		description: page.description,
		canonicalPath: page.path,
		og: { title, description: page.description, imagePath: '/og/home.png' },
	}
}
