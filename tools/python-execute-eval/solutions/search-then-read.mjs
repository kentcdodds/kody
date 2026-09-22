import { kody } from 'kody:runtime'

export default async function main(params) {
	const found = await kody.call('search', { query: params.query })
	const top = found.hits[0]
	const detail = await kody.call('notes.get', { id: top.id })
	return { id: top.id, text: detail.text }
}
