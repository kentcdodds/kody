export default function main(params) {
	const mean =
		params.values.reduce((sum, value) => sum + value, 0) / params.values.length
	return { mean: Math.round(mean * 1_000_000) / 1_000_000 }
}
