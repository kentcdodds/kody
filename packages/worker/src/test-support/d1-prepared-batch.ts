type PreparedD1BatchStatement = {
	query?: string
	all?: () => Promise<unknown>
	run?: () => Promise<unknown>
}

/**
 * Execute a D1 `batch()` of already-bound statements in node tests.
 * SELECT statements (or statements with no query string) use `all()` so
 * row results are returned; writes use `run()`.
 */
export async function executePreparedD1Batch(
	statements: Array<PreparedD1BatchStatement>,
) {
	const results = []
	for (const statement of statements) {
		const query = statement.query ?? ''
		const isSelect = query === '' || /^\s*select\b/i.test(query)
		if (isSelect && typeof statement.all === 'function') {
			results.push(await statement.all())
		} else if (typeof statement.run === 'function') {
			results.push(await statement.run())
		} else if (typeof statement.all === 'function') {
			results.push(await statement.all())
		} else {
			results.push({ results: [], meta: { changes: 0 } })
		}
	}
	return results
}
