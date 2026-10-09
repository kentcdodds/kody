export const softDeleteRetentionDays = 30

export function softDeletePurgeCutoffIso(now: Date = new Date()): string {
	const cutoff = new Date(now.getTime())
	cutoff.setUTCDate(cutoff.getUTCDate() - softDeleteRetentionDays)
	return cutoff.toISOString()
}

export function isWithinSoftDeleteRestoreWindow(
	deletedAt: string,
	now: Date = new Date(),
): boolean {
	const deletedMs = Date.parse(deletedAt)
	if (Number.isNaN(deletedMs)) return false
	const cutoffMs = Date.parse(softDeletePurgeCutoffIso(now))
	return deletedMs >= cutoffMs
}
