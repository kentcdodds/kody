import { expect, test } from 'vitest'
import { createExecutionSecretRedactor } from './execution-secret-redactor.ts'

const apiToken = `kody_at_${'a1'.repeat(10)}_${'Z'.repeat(43)}`
const bootstrapCode = `kody_bc_${'a'.repeat(16)}_${'B'.repeat(32)}`

test('redacts Kody credentials in errors without tracked secrets and still redacts tracked values', () => {
	const redactor = createExecutionSecretRedactor()
	expect(
		redactor.redactErrorMessage(`token=${apiToken} bootstrap=${bootstrapCode}`),
	).toBe('token=kody_at_[redacted] bootstrap=kody_bc_[redacted]')
	expect(
		redactor.redactUnknown({ nested: [{ token: apiToken }], count: 1 }),
	).toEqual({ nested: [{ token: 'kody_at_[redacted]' }], count: 1 })
	const untouched = { ok: true }
	expect(redactor.redactUnknown(untouched)).toBe(untouched)

	const redacted = redactor.redactUnknown({
		error: new Error(`fetch failed with ${apiToken}`),
	}) as { error: unknown }
	expect(JSON.stringify(redacted)).not.toContain(apiToken)
	const direct = redactor.redactUnknown(new Error(`bad ${apiToken}`))
	expect(direct instanceof Error ? direct.message : String(direct)).toBe(
		'bad kody_at_[redacted]',
	)

	redactor.track('hunter2')
	expect(redactor.redactUnknown(`hunter2 ${apiToken} ${bootstrapCode}`)).toBe(
		`[REDACTED SECRET] kody_at_[redacted] ${bootstrapCode}`,
	)
})

test('leaves bootstrap codes intact in ordinary result redaction', () => {
	const redactor = createExecutionSecretRedactor()
	expect(redactor.redactUnknown({ bootstrapCode })).toEqual({ bootstrapCode })
})
