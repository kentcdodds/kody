import { docHref, resolveLegacyDocSlug } from '#universal/docs-nav.ts'

const GITHUB_BLOB_BASE = 'https://github.com/kentcdodds/kody/blob/main'

/** Directory of a guide file inside the repo, relative to the repo root. */
export type GuideSourceDir = 'docs/guides' | 'docs/guides/providers'

function resolveRepoPath(baseDir: string, target: string): string | null {
	const segments = baseDir.split('/')
	for (const part of target.split('/')) {
		if (part === '' || part === '.') continue
		if (part === '..') {
			if (segments.length === 0) return null
			segments.pop()
			continue
		}
		segments.push(part)
	}
	return segments.join('/')
}

/**
 * Rewrite relative markdown link targets in a bundled guide body so every
 * serving surface (web page, raw `.md`, `{id}:guide` search) gets resolvable
 * links. The files on GitHub keep their authored relative form; this runs on
 * the bundled copy only.
 *
 * - Links to other bundled docs (`./oauth.md`, `providers/google.md`)
 *   become root-relative web routes (`/docs/oauth`; the introduction maps to
 *   `/docs`), which resolve against the deployment origin on every surface.
 *   A file that was merged into another doc resolves through
 *   `legacyDocSlugAliases` to the absorbing page and heading.
 * - Other repo-relative links (`../use/packages.md`) become absolute GitHub
 *   blob URLs, since those documents are not served on the web app.
 * - Absolute URLs, `mailto:`, anchors, and root-relative app links pass
 *   through untouched.
 */
export function rewriteRelativeGuideLinks(input: {
	body: string
	sourceDir: GuideSourceDir
	/** Known guide slugs, used to map guide files onto `/docs/:slug`. */
	knownSlugs: ReadonlySet<string>
}): string {
	const { body, sourceDir, knownSlugs } = input
	return body.replace(
		/\]\(([^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'))?)\)/g,
		(match, rawTarget: string, title: string) => {
			if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(rawTarget)) {
				return match
			}
			const [path = '', fragment] = rawTarget.split('#', 2)
			const resolved = resolveRepoPath(sourceDir, path)
			if (!resolved) return match

			const guideFile = /^docs\/guides\/(?:providers\/)?([a-z0-9-]+)\.md$/.exec(
				resolved,
			)
			if (guideFile) {
				const alias = resolveLegacyDocSlug(guideFile[1]!)
				if (knownSlugs.has(alias.slug)) {
					const resolvedFragment = fragment ?? alias.fragment
					const suffix = resolvedFragment ? `#${resolvedFragment}` : ''
					return `](${docHref(alias.slug)}${suffix}${title})`
				}
			}
			const suffix = fragment ? `#${fragment}` : ''
			return `](${GITHUB_BLOB_BASE}/${resolved}${suffix}${title})`
		},
	)
}
