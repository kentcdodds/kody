import { kody } from 'kody:runtime'

function mean(values) {
	return values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right)
	const mid = Math.floor(sorted.length / 2)
	if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2
	return sorted[mid]
}

function pstdev(values) {
	const average = mean(values)
	const variance =
		values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
		values.length
	return Math.sqrt(variance)
}

function round6(value) {
	return Math.round(value * 1e6) / 1e6
}

export default async function main(params) {
	void kody
	const values = params.values
	return {
		mean: round6(mean(values)),
		median: round6(median(values)),
		pstdev: round6(pstdev(values)),
	}
}
