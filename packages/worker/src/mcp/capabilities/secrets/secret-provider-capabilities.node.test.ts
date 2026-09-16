import { expect, test } from 'vitest'
import { secretProvidersFlagKey } from '#mcp/secrets/secret-providers/flag.ts'
import { secretProviderBindCapability } from './secret-provider-bind.ts'
import { secretProviderListCapability } from './secret-provider-list.ts'
import { secretProviderLockCapability } from './secret-provider-lock.ts'
import { secretProviderUnbindCapability } from './secret-provider-unbind.ts'

test('secret provider capabilities declare the secret-providers flag', () => {
	for (const capability of [
		secretProviderListCapability,
		secretProviderBindCapability,
		secretProviderUnbindCapability,
		secretProviderLockCapability,
	]) {
		expect(capability.featureFlag).toBe(secretProvidersFlagKey)
	}
})
