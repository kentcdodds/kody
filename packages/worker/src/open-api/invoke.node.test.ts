import { expect, test } from 'vitest'
import {
	capabilityProxyObservationEntityId,
	capabilityProxyObservationEntityIdMaxLength,
} from './invoke.ts'

test('capabilityProxyObservationEntityId reserves space for failure codes', () => {
	const failureCode = 'feature_disabled'
	const baseEntityId = `capability-proxy:${'a'.repeat(300)}`
	const entityId = capabilityProxyObservationEntityId({
		baseEntityId,
		outcome: 'error',
		failureCode,
	})
	expect(entityId.length).toBe(capabilityProxyObservationEntityIdMaxLength)
	expect(entityId.endsWith(`:${failureCode}`)).toBe(true)
	expect(entityId.startsWith('capability-proxy:')).toBe(true)

	expect(
		capabilityProxyObservationEntityId({
			baseEntityId,
			outcome: 'success',
		}),
	).toHaveLength(capabilityProxyObservationEntityIdMaxLength)
})
