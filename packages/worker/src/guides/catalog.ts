import { sortGuidesByAuthoredOrder } from './guide-order.ts'
import { parseGuideMarkdown, type Guide } from './parse-frontmatter.ts'
import {
	rewriteRelativeGuideLinks,
	type GuideSourceDir,
} from './rewrite-relative-links.ts'
import {
	docsIntroSlug,
	docsNav,
	isReservedDocsIndexSlug,
	type DocsNavSection,
} from '#universal/docs-nav.ts'
import accountPackageInvocationTokenSetup from '../../../../docs/guides/account-package-invocation-token-setup.md'
import accountSecretSetup from '../../../../docs/guides/account-secret-setup.md'
import connectYourAgent from '../../../../docs/guides/connect-your-agent.md'
import firstWin from '../../../../docs/guides/first-win.md'
import howKodyWorks from '../../../../docs/guides/how-kody-works.md'
import googleOauth from '../../../../docs/guides/google-oauth.md'
import kodyFactory from '../../../../docs/guides/kody-factory.md'
import localMcpTunnels from '../../../../docs/guides/local-mcp-tunnels.md'
import heavyWorkOffload from '../../../../docs/guides/heavy-work-offload.md'
import memory from '../../../../docs/guides/memory.md'
import quickExample from '../../../../docs/guides/quick-example.md'
import integrationBootstrap from '../../../../docs/guides/integration-bootstrap.md'
import lockedGmailDrafts from '../../../../docs/guides/locked-gmail-drafts.md'
import lockedMcpServer from '../../../../docs/guides/locked-mcp-server.md'
import oauth from '../../../../docs/guides/oauth.md'
import openapiIntegrations from '../../../../docs/guides/openapi-integrations.md'
import packageAuthoring from '../../../../docs/guides/package-authoring.md'
import packageApps from '../../../../docs/guides/package-apps.md'
import packageLifecycle from '../../../../docs/guides/package-lifecycle.md'
import platformEfficiency from '../../../../docs/guides/platform-efficiency.md'
import packagesIntegrationsMcp from '../../../../docs/guides/packages-integrations-mcp.md'
import packageSubscriptions from '../../../../docs/guides/package-subscriptions.md'
import platformFriction from '../../../../docs/guides/platform-friction.md'
import providerDiscord from '../../../../docs/guides/providers/discord.md'
import providerGithub from '../../../../docs/guides/providers/github.md'
import providerGoogle from '../../../../docs/guides/providers/google.md'
import providerNotion from '../../../../docs/guides/providers/notion.md'
import providerOrigin from '../../../../docs/guides/providers/origin.md'
import providerSalesforce from '../../../../docs/guides/providers/salesforce.md'
import providerSlack from '../../../../docs/guides/providers/slack.md'
import providerSpotify from '../../../../docs/guides/providers/spotify.md'
import secretBackedIntegration from '../../../../docs/guides/secret-backed-integration.md'
import secrets from '../../../../docs/guides/secrets.md'
import triggers from '../../../../docs/guides/triggers.md'
import values from '../../../../docs/guides/values.md'
import whatIsKody from '../../../../docs/guides/what-is-kody.md'
import onboarding from '../../../../docs/guides/onboarding.md'
import portability from '../../../../docs/guides/portability.md'

/**
 * Static doc sources. The canonical markdown lives in `docs/guides/` (also
 * readable on GitHub); this catalog bundles it so the MCP `{id}:guide`
 * search entity, the `/docs` web pages, and the raw `text/markdown`
 * responses all serve exactly the same deployed content. When adding a doc,
 * drop a `.md` file with the frontmatter contract (see
 * `parse-frontmatter.ts`) under `docs/guides/`, add one import + entry
 * here, and place it in `#universal/docs-nav.ts`. Slug = filename minus
 * `.md`.
 */
const guideSources: Array<{ slug: string; raw: string }> = [
	{ slug: 'what-is-kody', raw: whatIsKody },
	{ slug: 'how-kody-works', raw: howKodyWorks },
	{ slug: 'kody-factory', raw: kodyFactory },
	{ slug: 'connect-your-agent', raw: connectYourAgent },
	{ slug: 'onboarding', raw: onboarding },
	{ slug: 'quick-example', raw: quickExample },
	{ slug: 'portability', raw: portability },
	{ slug: 'first-win', raw: firstWin },
	{ slug: 'memory', raw: memory },
	{ slug: 'secrets', raw: secrets },
	{ slug: 'packages-integrations-mcp', raw: packagesIntegrationsMcp },
	{ slug: 'triggers', raw: triggers },
	{ slug: 'platform-efficiency', raw: platformEfficiency },
	{ slug: 'package-lifecycle', raw: packageLifecycle },
	{ slug: 'package-authoring', raw: packageAuthoring },
	{ slug: 'package-apps', raw: packageApps },
	{ slug: 'package-subscriptions', raw: packageSubscriptions },
	{ slug: 'heavy-work-offload', raw: heavyWorkOffload },
	{ slug: 'integration-bootstrap', raw: integrationBootstrap },
	{ slug: 'oauth', raw: oauth },
	{ slug: 'google-oauth', raw: googleOauth },
	{ slug: 'secret-backed-integration', raw: secretBackedIntegration },
	{ slug: 'account-secret-setup', raw: accountSecretSetup },
	{ slug: 'openapi-integrations', raw: openapiIntegrations },
	{ slug: 'local-mcp-tunnels', raw: localMcpTunnels },
	{ slug: 'locked-mcp-server', raw: lockedMcpServer },
	{ slug: 'locked-gmail-drafts', raw: lockedGmailDrafts },
	{ slug: 'discord', raw: providerDiscord },
	{ slug: 'github', raw: providerGithub },
	{ slug: 'google', raw: providerGoogle },
	{ slug: 'notion', raw: providerNotion },
	{ slug: 'origin', raw: providerOrigin },
	{ slug: 'salesforce', raw: providerSalesforce },
	{ slug: 'slack', raw: providerSlack },
	{ slug: 'spotify', raw: providerSpotify },
	{ slug: 'platform-friction', raw: platformFriction },
	{ slug: 'values', raw: values },
	{
		slug: 'account-package-invocation-token-setup',
		raw: accountPackageInvocationTokenSetup,
	},
]

function buildCatalog(): ReadonlyArray<Guide> {
	const parsed = guideSources.map(({ slug, raw }) =>
		parseGuideMarkdown(slug, raw),
	)
	const ids = new Set<string>()
	for (const guide of parsed) {
		if (ids.has(guide.id)) {
			throw new Error(`Duplicate guide id "${guide.id}".`)
		}
		ids.add(guide.id)
		if (isReservedDocsIndexSlug(guide.slug)) {
			throw new Error(
				`Guide slug "${guide.slug}" is reserved for a /docs index route.`,
			)
		}
	}
	// Authored bodies keep GitHub-relative links; the bundled copies rewrite
	// them so every serving surface gets resolvable targets.
	const knownSlugs = new Set(parsed.map((guide) => guide.slug))
	const rewritten = parsed.map((guide) => {
		const sourceDir: GuideSourceDir =
			guide.category === 'provider' ? 'docs/guides/providers' : 'docs/guides'
		return {
			...guide,
			body: rewriteRelativeGuideLinks({
				body: guide.body,
				sourceDir,
				knownSlugs,
			}),
		}
	})
	// `guideSources` above is already written in reading order, but sorting
	// through the shared `guide-order.ts` helper (rather than relying on that
	// literal array order) makes the order an explicit, enforced invariant
	// shared with the generated catalog modules — see guide-order.ts.
	return sortGuidesByAuthoredOrder(rewritten)
}

export const guides: ReadonlyArray<Guide> = buildCatalog()

const guidesBySlug = new Map(guides.map((guide) => [guide.slug, guide]))
const guidesById = new Map(guides.map((guide) => [guide.id, guide]))

export function getGuideBySlug(slug: string): Guide | null {
	return guidesBySlug.get(slug) ?? null
}

export function getGuideById(id: string): Guide | null {
	return guidesById.get(id) ?? null
}

/** The introduction article rendered at `/docs`. */
export function getIntroGuide(): Guide {
	const intro = guidesBySlug.get(docsIntroSlug)
	if (!intro) {
		throw new Error(`Missing introduction doc "${docsIntroSlug}".`)
	}
	return intro
}

/** Advertised platform docs in reading order. */
export function listPlatformGuides(): ReadonlyArray<Guide> {
	return guides.filter(
		(guide) => !guide.unadvertised && guide.category === 'platform',
	)
}

/**
 * Advertised provider (connection) docs, alphabetically by provider name —
 * the order `/docs/connect` renders.
 */
export function listProviderGuides(): ReadonlyArray<Guide> {
	return guides
		.filter((guide) => !guide.unadvertised && guide.category === 'provider')
		.toSorted((a, b) => (a.provider ?? '').localeCompare(b.provider ?? ''))
}

/**
 * Every advertised doc in reading order (sidebar order: platform sections,
 * then providers, then help). Used by sitemap, `llms.txt`, and surfaces that
 * need every advertised doc.
 */
export function listGuides(): ReadonlyArray<Guide> {
	return guides.filter((guide) => !guide.unadvertised)
}

export type GuidesBySection = {
	section: DocsNavSection
	guides: ReadonlyArray<Guide>
}

/** Advertised docs grouped by docs-nav section, in reading order. */
export function listGuidesBySection(): ReadonlyArray<GuidesBySection> {
	return docsNav.map((section) => ({
		section,
		guides: section.items
			.map((item) => guidesBySlug.get(item.slug))
			.filter((guide): guide is Guide => Boolean(guide && !guide.unadvertised)),
	}))
}

/** Index / API summary shape (no markdown body). */
export type GuideSummary = {
	slug: string
	id: string
	title: string
	summary: string
	category: Guide['category']
	audience: Guide['audience']
	section: string | null
	provider: string | null
	lastVerified: string | null
}

export function toGuideSummary(guide: Guide): GuideSummary {
	const section = docsNav.find((candidate) =>
		candidate.items.some((item) => item.slug === guide.slug),
	)
	return {
		slug: guide.slug,
		id: guide.id,
		title: guide.title,
		summary: guide.summary,
		category: guide.category,
		audience: guide.audience,
		section: section?.id ?? null,
		provider: guide.provider,
		lastVerified: guide.lastVerified,
	}
}
