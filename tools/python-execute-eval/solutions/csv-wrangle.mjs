import { kody } from 'kody:runtime'

export default async function main(params) {
	void kody
	const [header, ...lines] = params.csv.trim().split('\n')
	const columns = header.split(',')
	const totals = {}
	for (const line of lines) {
		const cells = line.split(',')
		const row = Object.fromEntries(
			columns.map((column, index) => [column, cells[index]]),
		)
		const qty = Number(row.qty)
		const revenue = qty * Number(row.price)
		const current = totals[row.sku] ?? { qty: 0, revenue: 0 }
		current.qty += qty
		current.revenue += revenue
		totals[row.sku] = current
	}
	return { by_sku: totals }
}
