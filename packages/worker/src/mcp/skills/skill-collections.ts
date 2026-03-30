const maxCollectionNameLength = 80

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim()
}

export function normalizeSkillCollectionName(
	value: string | null | undefined,
): string | null {
	if (value == null) return null
	const normalized = collapseWhitespace(value)
	if (normalized.length === 0) return null
	return normalized.slice(0, maxCollectionNameLength)
}

export function slugifySkillCollectionName(value: string): string {
	const normalized = normalizeSkillCollectionName(value)
	if (!normalized) return 'general'
	const ascii = normalized
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
	const slug = ascii
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
	return slug.length > 0 ? slug : 'general'
}

export function parseSkillCollection(value: string | null | undefined): {
	name: string
	slug: string
} | null {
	const name = normalizeSkillCollectionName(value)
	if (!name) return null
	return {
		name,
		slug: slugifySkillCollectionName(name),
	}
}
