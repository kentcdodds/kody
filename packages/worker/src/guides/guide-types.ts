export type GuideCategory = 'platform' | 'provider'

export type GuideFrontmatter = {
	/** Stable MCP guide id (snake_case), e.g. `integration_bootstrap`. */
	id: string
	title: string
	/**
	 * One-paragraph routing copy shared by the MCP catalog, web index, and
	 * page metadata: what the guide covers and when to load it.
	 */
	summary: string
	category: GuideCategory
	/** Optional origin-relative artwork shown on the guide and used for OG. */
	image: string | null
	/** Accessible description required when `image` is present. */
	imageAlt: string | null
	/** Optional Satori-compatible artwork composed into the generated OG card. */
	ogImage: string | null
	/** Display name of the third-party provider (provider guides only). */
	provider: string | null
	/**
	 * `YYYY-MM` month when the provider-side steps were last verified against
	 * the real console. Required for provider guides, which describe
	 * third-party surfaces that change without notice.
	 */
	lastVerified: string | null
	/**
	 * When true, the guide stays callable by exact id but is omitted from
	 * web/agent listings and `{id}:guide` search advertisements.
	 */
	unadvertised: boolean
}

export type Guide = GuideFrontmatter & {
	/** URL slug on the web (`/guides/:slug`), derived from the filename. */
	slug: string
	/** Markdown body without the frontmatter block. */
	body: string
}

/**
 * `Guide` without the markdown body. Cheap enough to statically import on
 * every isolate cold start (see `tools/build-guide-catalog-modules.ts` and
 * `#worker/guide-catalog-modules.ts`), unlike the full catalog.
 *
 * Deliberately split from `parse-frontmatter.ts`: these are pure types with
 * no parsing logic, so a capability that only needs guide *shapes* (not
 * `parseGuideMarkdown` itself) can reference this module without pulling
 * `parse-frontmatter.ts`'s parser into its bundle.
 */
export type GuideMetadata = Omit<Guide, 'body'>
