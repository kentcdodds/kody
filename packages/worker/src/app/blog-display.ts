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
	// Fixed locale/format ("July 20, 2026" — the redesign's editorial date
	// voice) so server-rendered HTML and client hydration always agree.
	return new Date(year, month - 1, day).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	})
}

export const BLOG_AUTHOR_NAME = 'Kent C. Dodds'

export const BLOG_PLACEHOLDER_CALLOUT =
	"This post is a placeholder and was written by AI. It's probably still useful, but if you're reading this it's because Kent hasn't yet gotten the chance to come back around and write it himself. Feel free to ping him and remind him he still needs to write the blog posts."
