/**
 * SQL literal quoting for test seeding and tooling that shells out to
 * `wrangler d1 execute`. Application code must keep using bound parameters;
 * these helpers exist only where parameter binding is unavailable.
 */
export function quoteSqlString(value: string) {
	return `'${value.replace(/'/g, "''")}'`
}

export function quoteSqlIdentifier(identifier: string) {
	return `"${identifier.replaceAll('"', '""')}"`
}
