import { expect, test } from 'vitest'
import { isNonProductionRuntime } from './deployment-env.ts'

test('deployment env treats production as closed and recognizes non-production runtimes', () => {
	expect(isNonProductionRuntime({ SENTRY_ENVIRONMENT: 'production' })).toBe(
		false,
	)
	expect(isNonProductionRuntime({})).toBe(false)
	expect(isNonProductionRuntime({ SENTRY_ENVIRONMENT: undefined })).toBe(false)
	expect(isNonProductionRuntime({ WRANGLER_IS_LOCAL_DEV: 'true' })).toBe(true)
	expect(isNonProductionRuntime({ SENTRY_ENVIRONMENT: 'preview' })).toBe(true)
	expect(isNonProductionRuntime({ SENTRY_ENVIRONMENT: 'test' })).toBe(true)
})
