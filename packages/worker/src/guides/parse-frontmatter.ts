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
	/** Display name of the third-party provider (provider guides only). */
	provider: string | null
	/**
	 * `YYYY-MM` month when the provider-side steps were last verified against
	 * the real console. Required for provider guides, which describe
	 * third-party surfaces that change without notice.
	 */
	lastVerified: string | null
}

export type Guide = GuideFrontmatter & {
	/** URL slug on the web (`/guides/:slug`), derived from the filename. */
	slug: string
	/** Markdown body without the frontmatter block. */
	body: string
}

const GUIDE_ID_PATTERN = /^[a-z][a-z0-9_]*$/
const LAST_VERIFIED_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/

/**
 * Parse a guide markdown file with the fixed frontmatter contract:
 *
 * ```
 * ---
 * id: integration_bootstrap
 * title: <string>
 * summary: <string, may continue on indented lines>
 * category: platform | provider
 * provider: <string, provider guides only>
 * lastVerified: YYYY-MM (required when category is provider)
 * ---
 * <markdown body>
 * ```
 *
 * Values may be inline (`key: value`) or a single-level indented block after
 * `key:` (joined with spaces). Unknown keys and blank lines are ignored.
 * Throws on missing fence, missing required fields, or invalid values.
 */
export function parseGuideMarkdown(slug: string, raw: string): Guide {
	const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
	if (!normalized.startsWith('---\n')) {
		throw new Error(`Guide "${slug}" is missing opening frontmatter fence.`)
	}

	const endIndex = normalized.indexOf('\n---\n', 4)
	if (endIndex === -1) {
		throw new Error(`Guide "${slug}" is missing closing frontmatter fence.`)
	}

	const frontmatterBlock = normalized.slice(4, endIndex)
	const body = normalized.slice(endIndex + '\n---\n'.length).replace(/^\n/, '')

	const fields = new Map<string, string>()
	let currentKey: string | null = null
	const currentParts: Array<string> = []

	function commitCurrentKey() {
		if (currentKey === null) return
		fields.set(currentKey, currentParts.join(' ').trim())
		currentKey = null
		currentParts.length = 0
	}

	for (const line of frontmatterBlock.split('\n')) {
		if (line.trim() === '') continue

		const indentedContinuation = /^(?: {2}|\t)\s*(.*)$/.exec(line)
		if (indentedContinuation && currentKey !== null) {
			const part = indentedContinuation[1]!.trim()
			if (part) currentParts.push(part)
			continue
		}

		const colonIndex = line.indexOf(':')
		if (colonIndex === -1) {
			throw new Error(
				`Guide "${slug}" has an invalid frontmatter line: ${line}`,
			)
		}

		commitCurrentKey()
		currentKey = line.slice(0, colonIndex).trim()
		const inlineValue = line.slice(colonIndex + 1).trim()
		if (inlineValue) {
			currentParts.push(inlineValue)
			commitCurrentKey()
		}
	}
	commitCurrentKey()

	const id = fields.get('id')
	const title = fields.get('title')
	const summary = fields.get('summary')
	const category = fields.get('category')
	const provider = fields.get('provider') ?? null
	const lastVerified = fields.get('lastVerified') ?? null

	if (!id) {
		throw new Error(`Guide "${slug}" is missing frontmatter "id".`)
	}
	if (!GUIDE_ID_PATTERN.test(id)) {
		throw new Error(
			`Guide "${slug}" has invalid frontmatter "id" (expected snake_case).`,
		)
	}
	if (!title) {
		throw new Error(`Guide "${slug}" is missing frontmatter "title".`)
	}
	if (!summary) {
		throw new Error(`Guide "${slug}" is missing frontmatter "summary".`)
	}
	if (category !== 'platform' && category !== 'provider') {
		throw new Error(
			`Guide "${slug}" has invalid frontmatter "category" (expected "platform" or "provider").`,
		)
	}
	if (category === 'provider' && !provider) {
		throw new Error(
			`Guide "${slug}" is missing frontmatter "provider" (required for provider guides).`,
		)
	}
	if (category === 'provider' && !lastVerified) {
		throw new Error(
			`Guide "${slug}" is missing frontmatter "lastVerified" (required for provider guides).`,
		)
	}
	if (lastVerified !== null && !LAST_VERIFIED_PATTERN.test(lastVerified)) {
		throw new Error(
			`Guide "${slug}" has invalid frontmatter "lastVerified" (expected YYYY-MM).`,
		)
	}

	return {
		slug,
		id,
		title,
		summary,
		category,
		provider,
		lastVerified,
		body,
	}
}
