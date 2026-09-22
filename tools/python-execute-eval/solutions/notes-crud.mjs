import { kody } from 'kody:runtime'

export default async function main(params) {
	for (const operation of params.ops) {
		switch (operation.op) {
			case 'write':
				await kody.call('notes.write', {
					id: operation.id,
					text: operation.text,
				})
				break
			case 'remove':
				await kody.call('notes.remove', { id: operation.id })
				break
			default:
				throw new Error(`Unknown operation: ${operation.op}`)
		}
	}
	return kody.call('notes.list', {})
}
