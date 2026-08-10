export function formatCommunityStars(
	averageStars: number | null,
	ratingCount: number,
) {
	if (ratingCount <= 0) return 'No ratings yet'
	const stars = averageStars == null ? '—' : averageStars.toFixed(1)
	return `★ ${stars} (${ratingCount})`
}

export function formatCommunityAdaptationEffort(value: number | null) {
	if (value == null) return '—'
	return value.toFixed(1)
}

export function formatCommunityPublishedDate(value: string) {
	// Fixed locale, format, and timezone ("July 13, 2026" — the redesign's
	// editorial date voice, matching `formatBlogPostDate`). This renders on the
	// server and again on hydration, so a runtime-dependent format would both
	// vary by host locale and risk a mismatch between the two.
	return new Date(value).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		timeZone: 'UTC',
	})
}

export function shortCommunityCommit(commit: string) {
	return commit.slice(0, 7)
}
