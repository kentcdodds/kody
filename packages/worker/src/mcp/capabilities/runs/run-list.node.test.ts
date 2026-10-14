import { expect, test } from 'vitest'
import { z } from 'zod'
import { runListInputSchema } from './run-list.ts'

test('runList accepts valid snake_case filters', () => {
	expect(
		runListInputSchema.parse({
			surface: 'webhook',
			error_triage: 'all',
			limit: 5,
		}),
	).toEqual({
		surface: 'webhook',
		error_triage: 'all',
		limit: 5,
	})
})

test('runList rejects camelCase and unknown keys with a did-you-mean hint', () => {
	const result = runListInputSchema.safeParse({
		surface: 'webhook',
		errorTriage: 'all',
		name: 'wake',
		limit: 5,
	})
	expect(result.success).toBe(false)
	if (result.success) return
	const message = z.prettifyError(result.error)
	expect(message).toContain(
		'errorTriage is not a parameter; did you mean error_triage?',
	)
	expect(message).toContain('name is not a parameter')
})

test('runList rejects packageId with a package_id hint', () => {
	const result = runListInputSchema.safeParse({ packageId: 'pkg-1' })
	expect(result.success).toBe(false)
	if (result.success) return
	expect(z.prettifyError(result.error)).toContain(
		'packageId is not a parameter; did you mean package_id?',
	)
})
