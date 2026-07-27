import { expect, test } from 'vitest'
import {
	assertAgentWritableValueName,
	assertValueNameAllowed,
	isPlatformReservedValueName,
} from './value-name-guards.ts'

test('platform-reserved value names block agent writes but stay structurally allowed', () => {
	expect(isPlatformReservedValueName('_integration:github')).toBe(true)
	expect(isPlatformReservedValueName('_openapi:widgets')).toBe(true)
	expect(isPlatformReservedValueName('preferred_repo')).toBe(false)
	expect(isPlatformReservedValueName('_integration')).toBe(false)

	expect(() => assertValueNameAllowed('_integration:github')).not.toThrow()
	expect(() => assertValueNameAllowed('_openapi:widgets')).not.toThrow()
	expect(() => assertAgentWritableValueName('_integration:github')).toThrow(
		Error,
	)
	expect(() => assertAgentWritableValueName('_openapi:widgets')).toThrow(Error)
	expect(() => assertAgentWritableValueName('user_config')).not.toThrow()
})
