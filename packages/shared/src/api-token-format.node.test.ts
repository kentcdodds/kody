import { expect, test } from 'vitest'
import { redactApiTokens, redactKodyCredentials } from './api-token-format.ts'

test('redactKodyCredentials redacts API tokens and CLI bootstrap codes', () => {
	const apiToken = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
	const bootstrapCode = `kody_bc_${'b'.repeat(16)}_${'C'.repeat(32)}`

	expect(redactKodyCredentials(`failed ${apiToken} and ${bootstrapCode}`)).toBe(
		'failed kody_at_[redacted] and kody_bc_[redacted]',
	)
	expect(redactApiTokens(bootstrapCode)).toBe(bootstrapCode)
})
