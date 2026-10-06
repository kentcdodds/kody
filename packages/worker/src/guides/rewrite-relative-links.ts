import {
	docHref,
	resolveLegacyDocSlug,
	useDocGuideTwins,
} from '#universal/docs-nav.ts'

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/kentcdodds/kody/main'

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
 * serving surface (web page, raw `.md`, `guide:{id}` search) gets resolvable
 * links. The files on GitHub keep their authored relative form; this runs on
 * the bundled copy only.
 *
 * - Links to other bundled docs (`./oauth.md`, `providers/google.md`)
 *   become root-relative web routes (`/docs/oauth`; the introduction maps to
 *   `/docs`), which resolve against the deployment origin on every surface.
 *   A file that was merged into another doc resolves through
 *   `legacyDocSlugAliases` to the absorbing page and heading.
 * - Links to a `docs/use` stub that only points at a catalog guide become
 *   that guide's `/docs` route.
 * - Other repo-relative links (`../use/packages.md`) become raw GitHub
 *   URLs (`raw.githubusercontent.com`), so an agent fetch returns the file
 *   instead of a GitHub HTML page. Those documents are not served on the
 *   web app.
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
			const useDoc = /^docs\/use\/([a-z0-9-]+)\.md$/.exec(resolved)
			const twinSlug = useDoc ? useDocGuideTwins[useDoc[1]!] : undefined
			if (twinSlug) {
				const alias = resolveLegacyDocSlug(twinSlug)
				if (knownSlugs.has(alias.slug)) {
					const resolvedFragment = fragment ?? alias.fragment
					const twinSuffix = resolvedFragment ? `#${resolvedFragment}` : ''
					return `](${docHref(alias.slug)}${twinSuffix}${title})`
				}
			}
			const suffix = fragment ? `#${fragment}` : ''
			return `](${GITHUB_RAW_BASE}/${resolved}${suffix}${title})`
		},
	)
}
