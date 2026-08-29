import { sortGuidesByAuthoredOrder } from './guide-order.ts'
import { parseGuideMarkdown, type Guide } from './parse-frontmatter.ts'
import {
	rewriteRelativeGuideLinks,
	type GuideSourceDir,
} from './rewrite-relative-links.ts'
import {
	isGuidesStartHereSlug,
	isReservedGuideIndexSlug,
} from '#universal/guide-sections.ts'
import accountPackageInvocationTokenSetup from '../../../../docs/guides/account-package-invocation-token-setup.md'
import accountSecretSetup from '../../../../docs/guides/account-secret-setup.md'
import firstWin from '../../../../docs/guides/first-win.md'
import howKodyWorks from '../../../../docs/guides/how-kody-works.md'
import googleOauth from '../../../../docs/guides/google-oauth.md'
import kodyFactory from '../../../../docs/guides/kody-factory.md'
import localMcpTunnels from '../../../../docs/guides/local-mcp-tunnels.md'
import quickExample from '../../../../docs/guides/quick-example.md'
import integrationBackedAppHappyPath from '../../../../docs/guides/integration-backed-app-happy-path.md'
import integrationBootstrap from '../../../../docs/guides/integration-bootstrap.md'
import lockedGmailDrafts from '../../../../docs/guides/locked-gmail-drafts.md'
import oauth from '../../../../docs/guides/oauth.md'
import openapiIntegrations from '../../../../docs/guides/openapi-integrations.md'
import packageAuthoring from '../../../../docs/guides/package-authoring.md'
import packageLifecycle from '../../../../docs/guides/package-lifecycle.md'
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
import values from '../../../../docs/guides/values.md'
import whatIsKody from '../../../../docs/guides/what-is-kody.md'

/**
 * Static guide sources. The canonical markdown lives in `docs/guides/` (also
 * readable on GitHub); this catalog bundles it so the MCP `coding_guide_get`
 * capability, the `/guides` web pages, and the raw `text/markdown` responses
 * all serve exactly the same deployed content. When adding a guide, drop a
 * `.md` file with the frontmatter contract (see `parse-frontmatter.ts`) under
 * `docs/guides/` and add one import + entry here. Slug = filename minus `.md`.
 */
const guideSources: Array<{ slug: string; raw: string }> = [
	{ slug: 'what-is-kody', raw: whatIsKody },
	{ slug: 'how-kody-works', raw: howKodyWorks },
	{ slug: 'kody-factory', raw: kodyFactory },
	{ slug: 'local-mcp-tunnels', raw: localMcpTunnels },
	{ slug: 'google-oauth', raw: googleOauth },
	{ slug: 'quick-example', raw: quickExample },
	{ slug: 'first-win', raw: firstWin },
	{ slug: 'package-authoring', raw: packageAuthoring },
	{ slug: 'package-lifecycle', raw: packageLifecycle },
	{ slug: 'integration-bootstrap', raw: integrationBootstrap },
	{ slug: 'locked-gmail-drafts', raw: lockedGmailDrafts },
	{ slug: 'secret-backed-integration', raw: secretBackedIntegration },
	{
		slug: 'integration-backed-app-happy-path',
		raw: integrationBackedAppHappyPath,
	},
	{ slug: 'oauth', raw: oauth },
	{ slug: 'account-secret-setup', raw: accountSecretSetup },
	{
		slug: 'account-package-invocation-token-setup',
		raw: accountPackageInvocationTokenSetup,
	},
	{ slug: 'package-subscriptions', raw: packageSubscriptions },
	{ slug: 'platform-friction', raw: platformFriction },
	{ slug: 'values', raw: values },
	{ slug: 'openapi-integrations', raw: openapiIntegrations },
	{ slug: 'google', raw: providerGoogle },
	{ slug: 'github', raw: providerGithub },
	{ slug: 'notion', raw: providerNotion },
	{ slug: 'origin', raw: providerOrigin },
	{ slug: 'salesforce', raw: providerSalesforce },
	{ slug: 'slack', raw: providerSlack },
	{ slug: 'spotify', raw: providerSpotify },
	{ slug: 'discord', raw: providerDiscord },
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
		if (isReservedGuideIndexSlug(guide.slug)) {
			throw new Error(
				`Guide slug "${guide.slug}" is reserved for a /guides index route.`,
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
	// `guideSources` above is already written in authored order, but sorting
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

/** Advertised platform guides in authored order. */
export function listPlatformGuides(): ReadonlyArray<Guide> {
	return guides.filter(
		(guide) => !guide.unadvertised && guide.category === 'platform',
	)
}

/**
 * Fundamentals for the `/guides` "Start here" group (authored order among
 * the start-here slug set).
 */
export function listStartHereGuides(): ReadonlyArray<Guide> {
	return listPlatformGuides().filter((guide) =>
		isGuidesStartHereSlug(guide.slug),
	)
}

/** Remaining platform guides after Start here, still in authored order. */
export function listMorePlatformGuides(): ReadonlyArray<Guide> {
	return listPlatformGuides().filter(
		(guide) => !isGuidesStartHereSlug(guide.slug),
	)
}

/**
 * Advertised provider (connection) guides, alphabetically by provider name —
 * the order `/guides/connect` renders.
 */
export function listProviderGuides(): ReadonlyArray<Guide> {
	return guides
		.filter((guide) => !guide.unadvertised && guide.category === 'provider')
		.toSorted((a, b) => (a.provider ?? '').localeCompare(b.provider ?? ''))
}

/**
 * Platform guides in authored order, then provider guides alphabetically by
 * provider name. Used by sitemap and surfaces that need every advertised
 * guide; the web `/guides` index uses the section helpers above instead.
 */
export function listGuides(): ReadonlyArray<Guide> {
	return [...listPlatformGuides(), ...listProviderGuides()]
}

/** Index / API summary shape (no markdown body). */
export type GuideSummary = {
	slug: string
	id: string
	title: string
	summary: string
	category: Guide['category']
	provider: string | null
	lastVerified: string | null
}

export function toGuideSummary(guide: Guide): GuideSummary {
	return {
		slug: guide.slug,
		id: guide.id,
		title: guide.title,
		summary: guide.summary,
		category: guide.category,
		provider: guide.provider,
		lastVerified: guide.lastVerified,
	}
}
