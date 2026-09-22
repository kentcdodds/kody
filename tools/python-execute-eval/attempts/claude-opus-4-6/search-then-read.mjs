import { kody } from 'kody:runtime'

export default async function main(params) {
	const results = await kody.call('search', { query: params.query })
	const hit = results.hits[0]
	return await kody.call('notes.get', { id: hit.id })
}
