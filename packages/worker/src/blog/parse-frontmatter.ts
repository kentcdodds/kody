export type BlogPostFrontmatter = {
	title: string
	date: string
	description: string
	order: number
}

export type BlogPost = BlogPostFrontmatter & {
	slug: string
	body: string
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Parse a blog markdown file with the fixed YAML-like frontmatter contract:
 *
 * ```
 * ---
 * title: <string>
 * date: YYYY-MM-DD
 * description: <string>
 * order: <number>
 * ---
 * <markdown body>
 * ```
 *
 * Values may be inline (`key: value`) or a single-level indented block after
 * `key:` (joined with spaces). Unknown keys and blank lines are ignored.
 * Throws on missing fence, missing required fields, or invalid `date`/`order`.
 */
export function parseBlogPostMarkdown(slug: string, raw: string): BlogPost {
	const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
	if (!normalized.startsWith('---\n')) {
		throw new Error(`Blog post "${slug}" is missing opening frontmatter fence.`)
	}

	const endIndex = normalized.indexOf('\n---\n', 4)
	if (endIndex === -1) {
		throw new Error(`Blog post "${slug}" is missing closing frontmatter fence.`)
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
				`Blog post "${slug}" has an invalid frontmatter line: ${line}`,
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

	const title = fields.get('title')
	const date = fields.get('date')
	const description = fields.get('description')
	const orderRaw = fields.get('order')

	if (!title) {
		throw new Error(`Blog post "${slug}" is missing frontmatter "title".`)
	}
	if (!date) {
		throw new Error(`Blog post "${slug}" is missing frontmatter "date".`)
	}
	if (!DATE_PATTERN.test(date)) {
		throw new Error(
			`Blog post "${slug}" has invalid frontmatter "date" (expected YYYY-MM-DD).`,
		)
	}
	if (!description) {
		throw new Error(`Blog post "${slug}" is missing frontmatter "description".`)
	}
	if (orderRaw === undefined) {
		throw new Error(`Blog post "${slug}" is missing frontmatter "order".`)
	}
	if (!/^-?\d+$/.test(orderRaw)) {
		throw new Error(
			`Blog post "${slug}" has invalid frontmatter "order" (expected integer).`,
		)
	}

	return {
		slug,
		title,
		date,
		description,
		order: Number(orderRaw),
		body,
	}
}
