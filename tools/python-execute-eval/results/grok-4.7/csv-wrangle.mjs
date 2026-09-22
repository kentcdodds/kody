export default function main(params) {
	const bySku = {}
	const [header, ...lines] = params.csv.trim().split('\n')
	const columns = header.split(',')
	const skuIndex = columns.indexOf('sku')
	const qtyIndex = columns.indexOf('qty')
	const priceIndex = columns.indexOf('price')
	for (const line of lines) {
		if (!line) continue
		const cells = line.split(',')
		const sku = cells[skuIndex]
		const qty = Number(cells[qtyIndex])
		const price = Number(cells[priceIndex])
		const bucket = (bySku[sku] ??= { qty: 0, revenue: 0 })
		bucket.qty += qty
		bucket.revenue += qty * price
	}
	return { by_sku: bySku }
}
