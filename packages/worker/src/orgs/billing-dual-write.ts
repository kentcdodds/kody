/**
 * P3 dual-write: billing and entitlement columns stay on `users` until the
 * contract moves; mirror writes onto `orgs` where org id = stable_user_id.
 */
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export function preparePersonalOrgBillingUpdate(
	db: D1Database,
	stableUserId: string,
	setClause: string,
	values: ReadonlyArray<unknown>,
	orgWhereSuffix = '',
) {
	return db
		.prepare(
			`UPDATE orgs SET ${setClause} WHERE id = ?${andLiveDeletedAtSql()}${orgWhereSuffix}`,
		)
		.bind(...values, stableUserId)
}

export async function batchUsersAndPersonalOrgBillingUpdate(input: {
	db: D1Database
	stableUserId: string
	usersStatement: D1PreparedStatement
	orgSetClause: string
	orgValues: ReadonlyArray<unknown>
	orgWhereSuffix?: string
}) {
	return await input.db.batch([
		input.usersStatement,
		preparePersonalOrgBillingUpdate(
			input.db,
			input.stableUserId,
			input.orgSetClause,
			input.orgValues,
			input.orgWhereSuffix ?? '',
		),
	])
}
