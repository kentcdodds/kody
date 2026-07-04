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
	return new Date(value).toLocaleDateString()
}

export function shortCommunityCommit(commit: string) {
	return commit.slice(0, 7)
}
