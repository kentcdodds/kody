export async function runFreshnessAndRetry(input: {
	checkFreshness: () => Promise<unknown>
	retryBackup: () => Promise<unknown>
}): Promise<void> {
	const results = await Promise.allSettled([
		input.checkFreshness(),
		input.retryBackup(),
	])
	const errors = results.flatMap((result) =>
		result.status === 'rejected' ? [result.reason] : [],
	)
	if (errors.length === 1) throw errors[0]
	if (errors.length > 1) {
		throw new AggregateError(errors, 'Freshness and backup retry both failed.')
	}
}
