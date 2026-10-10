import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * A billing id is live when it is not deleting and not soft-deleted.
 * `users` and `orgs` share this filter so rollups and Durable Object duration
 * agree on which owners still exist.
 */
export function liveOwnerFilterSql(alias?: string): string {
	const column = (name: string) => (alias ? `${alias}.${name}` : name)
	return `${column('deleting_at')} IS NULL${andLiveDeletedAtSql(alias)}`
}

/** `idExpr` matches a live `users.stable_user_id`. */
export function liveUserMatchSql(idExpr: string): string {
	return `EXISTS (
			SELECT 1 FROM users
			WHERE stable_user_id = ${idExpr}
				AND ${liveOwnerFilterSql('users')}
		)`
}

/** `idExpr` matches a live `orgs.id`, including a team org with no users row. */
export function liveOrgMatchSql(idExpr: string): string {
	return `EXISTS (
			SELECT 1 FROM orgs
			WHERE id = ${idExpr}
				AND ${liveOwnerFilterSql('orgs')}
		)`
}

/**
 * SQL predicate: `idExpr` is system mail, a live person, or a live org.
 * Personal orgs reuse `stable_user_id`, so either branch matches them. This
 * is the only live-owner check for usage rollups and Durable Object duration.
 */
export function liveBillingOwnerSql(idExpr: string): string {
	return `(
		${idExpr} = 'system:email'
		OR ${liveUserMatchSql(idExpr)}
		OR ${liveOrgMatchSql(idExpr)}
	)`
}
