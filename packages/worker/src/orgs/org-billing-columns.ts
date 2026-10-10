/**
 * Billing and entitlement column writes on `orgs`. Personal org id equals
 * the owner's stable user id. Team orgs use their own id. These columns are
 * not written on `users`.
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

/** Billing write on one org row. */
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
