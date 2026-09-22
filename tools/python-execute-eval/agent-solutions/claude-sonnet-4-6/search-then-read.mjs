import { kody } from 'kody:runtime'

export default async function main(params) {
	const results = await kody.call('search', { query: params.query })
	const hits = results.hits ?? []
	if (hits.length === 0) throw new Error('No results found')
	return kody.call('notes.get', { id: hits[0].id })
}
