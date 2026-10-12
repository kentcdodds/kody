import { vi } from 'vitest'
import * as secretService from '#mcp/secrets/service.ts'

/**
 * Routes the credential door's metadata lookup (`findSecretForUse`) through
 * `resolveSecret`, so a test that stubs `resolveSecret` stubs both the lookup
 * and the value read. Call it in `beforeEach`: the shared config resets mocks
 * between tests.
 */
export function lookupSecretsThroughResolveSecret() {
	return vi
		.spyOn(secretService, 'findSecretForUse')
		.mockImplementation(async (input) => {
			const resolved = await secretService.resolveSecret(input)
			const { value: _value, ...found } = resolved
			return { found, readValue: async () => resolved }
		})
}
