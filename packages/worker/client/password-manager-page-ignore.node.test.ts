import { expect, test } from 'vitest'
import { passwordManagerPageIgnoreAttribute } from '#universal/password-manager-page-ignore.ts'
import { syncPasswordManagerPageIgnore } from './password-manager-page-ignore.ts'

test('sync adds the ignore off login and signup and removes it there', () => {
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
		syncPasswordManagerPageIgnore('/admin/users')
		expect(attributes.has(passwordManagerPageIgnoreAttribute)).toBe(true)

		syncPasswordManagerPageIgnore('/login')
		expect(attributes.has(passwordManagerPageIgnoreAttribute)).toBe(false)

		syncPasswordManagerPageIgnore('/account')
		expect(attributes.has(passwordManagerPageIgnoreAttribute)).toBe(true)

		syncPasswordManagerPageIgnore('/signup')
		expect(attributes.has(passwordManagerPageIgnoreAttribute)).toBe(false)
	} finally {
		globalThis.document = previous
	}
})
