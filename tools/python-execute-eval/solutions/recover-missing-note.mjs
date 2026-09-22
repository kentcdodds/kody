import { kody } from 'kody:runtime'

export default async function main(params) {
	try {
		await kody.call('notes.get', { id: params.id })
		return { recovered: false }
	} catch (error) {
		return {
			recovered: true,
			reason: error instanceof Error ? error.message : String(error),
		}
	}
}
