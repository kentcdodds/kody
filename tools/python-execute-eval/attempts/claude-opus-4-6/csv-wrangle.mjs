export default function main(params) {
	const lines = params.csv.trim().split('\n')
	const headers = lines[0].split(',')
	const by_sku = {}
	for (let i = 1; i < lines.length; i++) {
		const values = lines[i].split(',')
		const sku = values[0]
		const qty = Number(values[1])
		const price = Number(values[2])
		if (!by_sku[sku]) by_sku[sku] = { qty: 0, revenue: 0 }
		by_sku[sku].qty += qty
		by_sku[sku].revenue += qty * price
	}
	return { by_sku }
}
