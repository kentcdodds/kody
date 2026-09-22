import { kody } from 'kody:runtime'

export default async function main(params) {
	try {
		await kody.call('notes.get', { id: params.id })
		return { recovered: false, reason: null }
	} catch (e) {
		return { recovered: true, reason: e.message }
	}
}
