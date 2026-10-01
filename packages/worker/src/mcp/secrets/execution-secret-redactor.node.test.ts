import { expect, test } from 'vitest'
import { createExecutionSecretRedactor } from './execution-secret-redactor.ts'

const apiToken = `kody_at_${'a1'.repeat(10)}_${'Z'.repeat(43)}`

test('redacts Kody API tokens without any tracked secret', () => {
	const redactor = createExecutionSecretRedactor()
	expect(redactor.redactErrorMessage(`token=${apiToken}`)).toBe(
		'token=kody_at_[redacted]',
	)
	expect(
		redactor.redactUnknown({ nested: [{ token: apiToken }], count: 1 }),
	).toEqual({ nested: [{ token: 'kody_at_[redacted]' }], count: 1 })
	const untouched = { ok: true }
	expect(redactor.redactUnknown(untouched)).toBe(untouched)
})

test('redacts API tokens inside Error messages without tracked secrets', () => {
	const redactor = createExecutionSecretRedactor()
	const redacted = redactor.redactUnknown({
		error: new Error(`fetch failed with ${apiToken}`),
	}) as { error: unknown }
	expect(JSON.stringify(redacted)).not.toContain(apiToken)
	const direct = redactor.redactUnknown(new Error(`bad ${apiToken}`))
	expect(direct instanceof Error ? direct.message : String(direct)).toBe(
		'bad kody_at_[redacted]',
	)
})

test('still redacts tracked secret values alongside API tokens', () => {
	const redactor = createExecutionSecretRedactor()
	redactor.track('hunter2')
	expect(redactor.redactUnknown(`hunter2 ${apiToken}`)).toBe(
		'[REDACTED SECRET] kody_at_[redacted]',
	)
})
