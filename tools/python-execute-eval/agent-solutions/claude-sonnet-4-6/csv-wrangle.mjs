import { kody } from 'kody:runtime'

export default async function main(params) {
	const lines = params.csv.trim().split('\n')
	const headers = lines[0].split(',')
	const rows = lines.slice(1).map((line) => {
		const vals = line.split(',')
		return Object.fromEntries(headers.map((h, i) => [h, vals[i]]))
	})
	const by_sku = {}
	for (const row of rows) {
		const { sku } = row
		const qty = parseInt(row.qty, 10)
		const price = parseFloat(row.price)
		if (!by_sku[sku]) by_sku[sku] = { qty: 0, revenue: 0 }
		by_sku[sku].qty += qty
		by_sku[sku].revenue += qty * price
	}
	return { by_sku }
}
