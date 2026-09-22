export default function main(params) {
	const [header, ...lines] = params.csv.trim().split('\n')
	const columns = header.split(',')
	const totals = {}
	for (const line of lines) {
		const values = line.split(',')
		const row = Object.fromEntries(
			columns.map((column, index) => [column, values[index]]),
		)
		const item = (totals[row.sku] ??= { qty: 0, revenue: 0 })
		const quantity = Number(row.qty)
		item.qty += quantity
		item.revenue += quantity * Number(row.price)
	}
	return { by_sku: totals }
}
