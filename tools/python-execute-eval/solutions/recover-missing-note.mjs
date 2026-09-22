import { kody } from 'kody:runtime'

export default async function main(params) {
	try {
		await kody.call('notes.get', { id: params.id })
	} catch (error) {
		return {
			recovered: true,
			reason: error instanceof Error ? error.message : String(error),
		}
	}
	return { recovered: false, reason: '' }
}
