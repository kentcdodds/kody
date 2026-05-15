import { expect, test } from 'vitest'
import { secretDeleteCapability } from './secret-delete.ts'
import { secretListCapability } from './secret-list.ts'
import { secretSetCapability } from './secret-set.ts'

const secretChatProhibition =
	'Never ask users to paste secrets, tokens, API keys, passwords, or credentials into chat.'

test('secret capability descriptions keep secret collection out of chat', () => {
	for (const capability of [
		secretDeleteCapability,
		secretListCapability,
		secretSetCapability,
	]) {
		expect(capability.description).toContain('/connect/secret')
		expect(capability.description).toContain(secretChatProhibition)
	}
})
