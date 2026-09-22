import { kody } from 'kody:runtime'

export default async function main(params) {
	try {
		await kody.call('notes.get', { id: params.id })
	} catch (error) {
		return { recovered: true, reason: error.message }
	}
	return { recovered: false, reason: '' }
}
