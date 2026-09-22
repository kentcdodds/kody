import { kody } from 'kody:runtime'

export default async function main(params) {
	for (const op of params.ops) {
		if (op.op === 'write') {
			await kody.call('notes.write', { id: op.id, text: op.text })
		} else if (op.op === 'remove') {
			await kody.call('notes.remove', { id: op.id })
		}
	}
	return kody.call('notes.list', {})
}
