/** Opt-out marker for restore/purge writers; file-level comment satisfies the scanner. */
export const softDeleteReadFilterOptOutMarker =
	'soft-delete-read-filter: opt-out'

export function liveDeletedAtSql(alias?: string): string {
	if (alias == null || alias.trim() === '') {
		return 'deleted_at IS NULL'
	}
	return `${alias.trim()}.deleted_at IS NULL`
}

export function andLiveDeletedAtSql(alias?: string): string {
	return ` AND ${liveDeletedAtSql(alias)}`
}

export function withLiveDeletedAt(
	sqlWhereFragment: string,
	alias?: string,
): string {
	const trimmed = sqlWhereFragment.trim()
	const filter = liveDeletedAtSql(alias)
	if (trimmed === '') return filter
	return `${trimmed} AND ${filter}`
}
