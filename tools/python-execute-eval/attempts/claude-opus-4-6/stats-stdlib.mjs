export default function main(params) {
	const values = params.values
	const n = values.length
	const mean = values.reduce((s, v) => s + v, 0) / n
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(n / 2)
	const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
	const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n
	const pstdev = Math.sqrt(variance)
	return {
		mean: Math.round(mean * 1e6) / 1e6,
		median,
		pstdev: Math.round(pstdev * 1e6) / 1e6,
	}
}
