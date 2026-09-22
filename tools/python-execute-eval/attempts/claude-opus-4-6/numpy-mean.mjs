export default function main(params) {
	const values = params.values
	const mean = values.reduce((s, v) => s + v, 0) / values.length
	return { mean: Math.round(mean * 1e6) / 1e6 }
}
