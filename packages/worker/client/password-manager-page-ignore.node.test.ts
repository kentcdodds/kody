import { expect, test } from 'vitest'
import { passwordManagerPageIgnoreAttribute } from '#universal/password-manager-page-ignore.ts'
import { syncPasswordManagerPageIgnore } from './password-manager-page-ignore.ts'

test('sync adds the ignore on account pages and removes it on login', () => {
	const attributes = new Map<string, string>()
	const body = {
		setAttribute(name: string, value: string) {
			attributes.set(name, value)
		},
		removeAttribute(name: string) {
			attributes.delete(name)
		},
	}
	const previous = globalThis.document
	globalThis.document = { body } as unknown as Document

	try {
		syncPasswordManagerPageIgnore('/account')
		expect(attributes.has(passwordManagerPageIgnoreAttribute)).toBe(true)

		syncPasswordManagerPageIgnore('/login')
		expect(attributes.has(passwordManagerPageIgnoreAttribute)).toBe(false)
	} finally {
		globalThis.document = previous
	}
})
