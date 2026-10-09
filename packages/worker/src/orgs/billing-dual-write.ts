/**
 * P3 dual-write: billing and entitlement columns stay on `users` until the
 * contract moves; mirror writes onto `orgs` where org id = stable_user_id
 * (personal org only). Team orgs write the org row alone — never half
 * dual-write a team Stripe customer onto a member's personal org.
 */
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * Bind order: SET `values`, then the org id (`WHERE id = ?`), then
 * `orgWhereValues` for any `?` placeholders in `orgWhereSuffix`.
 */
export function prepareOrgBillingUpdate(
	db: D1Database,
	orgId: string,
	setClause: string,
	values: ReadonlyArray<unknown>,
	orgWhereSuffix = '',
	orgWhereValues: ReadonlyArray<unknown> = [],
) {
	return db
		.prepare(
			`UPDATE orgs SET ${setClause} WHERE id = ?${andLiveDeletedAtSql()}${orgWhereSuffix}`,
		)
		.bind(...values, orgId, ...orgWhereValues)
}

/** Personal org id equals the owner's stable user id. */
export function preparePersonalOrgBillingUpdate(
	db: D1Database,
	stableUserId: string,
	setClause: string,
	values: ReadonlyArray<unknown>,
	orgWhereSuffix = '',
	orgWhereValues: ReadonlyArray<unknown> = [],
) {
	return prepareOrgBillingUpdate(
		db,
		stableUserId,
		setClause,
		values,
		orgWhereSuffix,
		orgWhereValues,
	)
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
		prepareOrgBillingUpdate(
			input.db,
			input.stableUserId,
			input.orgSetClause,
			input.orgValues,
			input.orgWhereSuffix ?? '',
			input.orgWhereValues ?? [],
		),
	])
}

/** Team-org (or any org-row) billing write without touching a users row. */
export async function updateOrgBillingColumns(input: {
	db: D1Database
	orgId: string
	setClause: string
	values: ReadonlyArray<unknown>
	orgWhereSuffix?: string
	orgWhereValues?: ReadonlyArray<unknown>
}) {
	return await prepareOrgBillingUpdate(
		input.db,
		input.orgId,
		input.setClause,
		input.values,
		input.orgWhereSuffix ?? '',
		input.orgWhereValues ?? [],
	).run()
}
