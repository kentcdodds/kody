import { expect, test } from 'vitest'
import { assertCloneableStorageValue } from './storage-runner.ts'

test('assertCloneableStorageValue accepts JSON values and rejects Proxies', () => {
	expect(() => assertCloneableStorageValue(null)).not.toThrow()
	expect(() => assertCloneableStorageValue('plain')).not.toThrow()
	expect(() =>
		assertCloneableStorageValue({ roster: ['cole'], count: 1 }),
	).not.toThrow()
	expect(() =>
		assertCloneableStorageValue(new Date('2026-09-06T00:00:00Z')),
	).not.toThrow()

	expect(() => assertCloneableStorageValue(new Proxy({}, {}))).toThrow(
		/cannot be stored/,
	)
	expect(() => assertCloneableStorageValue(new Proxy(() => {}, {}))).toThrow(
		/cannot be stored/,
	)
	expect(() => assertCloneableStorageValue(() => 'fn')).toThrow(
		/cannot be stored/,
	)
})
