const maxSkillNameLength = 80

function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim()
}

export function normalizeSkillName(value: string): string {
	const normalized = collapseWhitespace(value)
	const ascii = normalized
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
	const slug = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
	if (!slug) {
		throw new Error('Skill names must contain at least one letter or number.')
	}
	const sliced = slug.slice(0, maxSkillNameLength).replace(/-+$/g, '')
	if (!sliced) {
		throw new Error('Skill names must contain at least one letter or number.')
	}
	return sliced
}
