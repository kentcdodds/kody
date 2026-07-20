/** Format a blog frontmatter date (`YYYY-MM-DD`) for display in local timezone. */
export function formatBlogPostDate(date: string) {
	const [year, month, day] = date.split('-').map(Number)
	if (
		year === undefined ||
		month === undefined ||
		day === undefined ||
		!Number.isFinite(year) ||
		!Number.isFinite(month) ||
		!Number.isFinite(day)
	) {
		return date
	}
	return new Date(year, month - 1, day).toLocaleDateString()
}

export const BLOG_AUTHOR_NAME = 'Kent C. Dodds'
