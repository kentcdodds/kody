/**
 * SQL predicate that keeps only `users` rows belonging to a person.
 *
 * Former platform accounts are ordinary orgs, but their `users` rows (no
 * person behind them) stay until Teams P9 deletes those rows and drops
 * `users.account_type` (#3084). Delete this predicate and its callers then.
 */
export function personUserRowSql(tableAlias?: string) {
	const column = tableAlias ? `${tableAlias}.account_type` : 'account_type'
	return `${column} = 'person'`
}
