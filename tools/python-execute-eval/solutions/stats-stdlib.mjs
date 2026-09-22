const round = (value) => Math.round(value * 1_000_000) / 1_000_000

export default function main(params) {
	const values = params.values
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length
	const sorted = [...values].sort((left, right) => left - right)
	const middle = sorted.length / 2
	const median =
		sorted.length % 2 === 0
			? (sorted[middle - 1] + sorted[middle]) / 2
			: sorted[Math.floor(middle)]
	const variance =
		values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
	return {
		mean: round(mean),
		median: round(median),
		pstdev: round(Math.sqrt(variance)),
	}
}
