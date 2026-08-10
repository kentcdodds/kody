import { parseGuideMarkdown, type Guide } from './parse-frontmatter.ts'
import {
	rewriteRelativeGuideLinks,
	type GuideSourceDir,
} from './rewrite-relative-links.ts'
import accountPackageInvocationTokenSetup from '../../../../docs/guides/account-package-invocation-token-setup.md'
import accountSecretSetup from '../../../../docs/guides/account-secret-setup.md'
import integrationBackedAppHappyPath from '../../../../docs/guides/integration-backed-app-happy-path.md'
import integrationBootstrap from '../../../../docs/guides/integration-bootstrap.md'
import oauth from '../../../../docs/guides/oauth.md'
import openapiIntegrations from '../../../../docs/guides/openapi-integrations.md'
import packageAuthoring from '../../../../docs/guides/package-authoring.md'
import packageLifecycle from '../../../../docs/guides/package-lifecycle.md'
import packageServicePattern from '../../../../docs/guides/package-service-pattern.md'
import packageSubscriptions from '../../../../docs/guides/package-subscriptions.md'
import platformFriction from '../../../../docs/guides/platform-friction.md'
import providerDiscord from '../../../../docs/guides/providers/discord.md'
import providerGithub from '../../../../docs/guides/providers/github.md'
import providerGoogle from '../../../../docs/guides/providers/google.md'
import providerNotion from '../../../../docs/guides/providers/notion.md'
import providerSlack from '../../../../docs/guides/providers/slack.md'
import providerSpotify from '../../../../docs/guides/providers/spotify.md'
import secretBackedIntegration from '../../../../docs/guides/secret-backed-integration.md'
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
	{ slug: 'package-authoring', raw: packageAuthoring },
	{ slug: 'package-lifecycle', raw: packageLifecycle },
	{ slug: 'integration-bootstrap', raw: integrationBootstrap },
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
	{ slug: 'package-service-pattern', raw: packageServicePattern },
	{ slug: 'package-subscriptions', raw: packageSubscriptions },
	{ slug: 'platform-friction', raw: platformFriction },
	{ slug: 'openapi-integrations', raw: openapiIntegrations },
	{ slug: 'google', raw: providerGoogle },
	{ slug: 'github', raw: providerGithub },
	{ slug: 'notion', raw: providerNotion },
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
	}
	// Authored bodies keep GitHub-relative links; the bundled copies rewrite
	// them so every serving surface gets resolvable targets.
	const knownSlugs = new Set(parsed.map((guide) => guide.slug))
	return parsed.map((guide) => {
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

/**
 * Platform guides in authored order, then provider guides alphabetically by
 * provider name — the order the web index renders.
 */
export function listGuides(): ReadonlyArray<Guide> {
	const platform = guides.filter((guide) => guide.category === 'platform')
	const provider = guides
		.filter((guide) => guide.category === 'provider')
		.toSorted((a, b) => (a.provider ?? '').localeCompare(b.provider ?? ''))
	return [...platform, ...provider]
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
