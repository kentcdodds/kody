/**
 * P3 dual-write: billing and entitlement columns stay on `users` until the
 * contract moves; mirror writes onto `orgs` where org id = stable_user_id.
 */
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * Bind order: SET `values`, then the org id (`WHERE id = ?`), then
 * `orgWhereValues` for any `?` placeholders in `orgWhereSuffix`.
 */
export function preparePersonalOrgBillingUpdate(
	db: D1Database,
	stableUserId: string,
	setClause: string,
	values: ReadonlyArray<unknown>,
	orgWhereSuffix = '',
	orgWhereValues: ReadonlyArray<unknown> = [],
) {
	return db
		.prepare(
			`UPDATE orgs SET ${setClause} WHERE id = ?${andLiveDeletedAtSql()}${orgWhereSuffix}`,
		)
		.bind(...values, stableUserId, ...orgWhereValues)
}

export async function batchUsersAndPersonalOrgBillingUpdate(input: {
	db: D1Database
	stableUserId: string
	usersStatement: D1PreparedStatement
	orgSetClause: string
	orgValues: ReadonlyArray<unknown>
	orgWhereSuffix?: string
	orgWhereValues?: ReadonlyArray<unknown>
}) {
	return await input.db.batch([
		input.usersStatement,
		preparePersonalOrgBillingUpdate(
			input.db,
			input.stableUserId,
			input.orgSetClause,
			input.orgValues,
			input.orgWhereSuffix ?? '',
			input.orgWhereValues ?? [],
		),
	])
}
