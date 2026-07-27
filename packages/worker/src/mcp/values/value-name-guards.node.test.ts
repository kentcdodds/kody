import { expect, test } from 'vitest'
import {
	assertAgentWritableValueName,
	assertValueNameAllowed,
	isPlatformReservedValueName,
} from './value-name-guards.ts'

test('isPlatformReservedValueName matches integration and openapi prefixes', () => {
	expect(isPlatformReservedValueName('_integration:github')).toBe(true)
	expect(isPlatformReservedValueName('_openapi:widgets')).toBe(true)
	expect(isPlatformReservedValueName('preferred_repo')).toBe(false)
	expect(isPlatformReservedValueName('_integration')).toBe(false)
})

test('assertAgentWritableValueName rejects platform prefixes with capability hints', () => {
	expect(() => assertAgentWritableValueName('_integration:github')).toThrow(
		'Use integration_save instead of value_set.',
	)
	expect(() => assertAgentWritableValueName('_openapi:widgets')).toThrow(
		'Use openapi_binding_save instead of value_set.',
	)
	expect(() => assertAgentWritableValueName('user_config')).not.toThrow()
})

test('assertValueNameAllowed remains separate from platform prefix checks', () => {
	expect(() => assertValueNameAllowed('_integration:github')).not.toThrow()
	expect(() => assertAgentWritableValueName('_integration:github')).toThrow()
})
