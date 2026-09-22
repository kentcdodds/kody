import { kody } from 'kody:runtime'

export default async function main(params) {
	const results = await kody.call('search', { query: params.query })
	return kody.call('notes.get', { id: results.hits[0].id })
}
