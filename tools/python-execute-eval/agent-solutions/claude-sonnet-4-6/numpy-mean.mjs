import { kody } from 'kody:runtime'

export default async function main(params) {
	const values = params.values
	const mean = values.reduce((sum, v) => sum + v, 0) / values.length
	return { mean: parseFloat(mean.toFixed(6)) }
}
