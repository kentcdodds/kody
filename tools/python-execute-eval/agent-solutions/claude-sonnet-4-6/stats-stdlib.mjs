import { kody } from 'kody:runtime'

export default async function main(params) {
	const values = params.values
	const n = values.length
	const mean = values.reduce((sum, v) => sum + v, 0) / n
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	const median =
		sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
	const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / n
	const pstdev = Math.sqrt(variance)
	const round6 = (x) => parseFloat(x.toFixed(6))
	return { mean: round6(mean), median: round6(median), pstdev: round6(pstdev) }
}
