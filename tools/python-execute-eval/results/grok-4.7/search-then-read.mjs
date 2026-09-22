import { kody } from 'kody:runtime'

export default async function main(params) {
	const found = await kody.call('search', { query: params.query })
	const hit = found.hits[0]
	return kody.call('notes.get', { id: hit.id })
}
