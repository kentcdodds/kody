import { expect, test } from 'vitest'
import { ApiError } from './errors.ts'

test('ApiError.toBody redacts Kody credentials in error details', () => {
	const apiToken = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
	const bootstrapCode = `kody_bc_${'b'.repeat(16)}_${'C'.repeat(32)}`

	const body = new ApiError({
		status: 400,
		code: 'invalid_request',
		message: 'Invalid details.',
		details: {
			credentials: [apiToken, { nested: `failed with ${bootstrapCode}` }],
		},
	}).toBody()

	expect(body.error.details).toEqual({
		credentials: [
			'kody_at_[redacted]',
			{ nested: 'failed with kody_bc_[redacted]' },
		],
	})
})
