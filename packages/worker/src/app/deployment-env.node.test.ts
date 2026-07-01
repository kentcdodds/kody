import { expect, test } from 'vitest'
import { isNonProductionRuntime } from './deployment-env.ts'

test('treats production wrangler env as production (fails closed)', () => {
	expect(isNonProductionRuntime({ SENTRY_ENVIRONMENT: 'production' })).toBe(
		false,
	)
	expect(isNonProductionRuntime({})).toBe(false)
	expect(isNonProductionRuntime({ SENTRY_ENVIRONMENT: undefined })).toBe(false)
})

test('recognizes local dev, preview, and test as non-production', () => {
	expect(isNonProductionRuntime({ WRANGLER_IS_LOCAL_DEV: 'true' })).toBe(true)
	expect(isNonProductionRuntime({ SENTRY_ENVIRONMENT: 'preview' })).toBe(true)
	expect(isNonProductionRuntime({ SENTRY_ENVIRONMENT: 'test' })).toBe(true)
})
