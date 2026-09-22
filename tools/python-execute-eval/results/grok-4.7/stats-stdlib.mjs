export default function main(params) {
	const values = params.values
	const count = values.length
	const mean = values.reduce((sum, value) => sum + value, 0) / count
	const sorted = [...values].sort((left, right) => left - right)
	const mid = Math.floor(count / 2)
	const median =
		count % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
	const variance =
		values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / count
	const round6 = (value) => Math.round(value * 1e6) / 1e6
	return {
		mean: round6(mean),
		median: round6(median),
		pstdev: round6(Math.sqrt(variance)),
	}
}
