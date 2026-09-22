import { kody } from 'kody:runtime'

export default async function main(params) {
	void kody
	const values = params.values
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length
	return { mean: Math.round(mean * 1e6) / 1e6 }
}
