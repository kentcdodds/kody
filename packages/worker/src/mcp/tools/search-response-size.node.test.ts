import { expect, test } from 'vitest'
import { applyMaxResponseSize } from './search-response-size.ts'

test('applyMaxResponseSize reserves room for appended memory text', () => {
	const payload = {
		matches: ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'],
	}
	const format = (value: { matches: Array<string> }) => value.matches.join('')
	const trim = (value: { matches: Array<string> }, count: number) => ({
		matches: value.matches.slice(0, count),
	})
	const getCount = (value: { matches: Array<string> }) => value.matches.length
	const suffix = 'MEMORY'
	const maxResponseSize = 16

	const unreserved = applyMaxResponseSize(
		payload,
		maxResponseSize,
		format,
		trim,
		getCount,
	)
	expect(unreserved.serialized.length).toBeLessThanOrEqual(maxResponseSize)
	expect(`${unreserved.serialized}\n${suffix}`.length).toBeGreaterThan(
		maxResponseSize,
	)

	const reserved = applyMaxResponseSize(
		payload,
		maxResponseSize,
		format,
		trim,
		getCount,
		{ reservedChars: suffix.length + 1 },
	)
	const combined = `${reserved.serialized}\n${suffix}`
	expect(combined).toContain(suffix)
	expect(combined.length).toBeLessThanOrEqual(maxResponseSize)

	const memoryLargerThanBudget = applyMaxResponseSize(
		payload,
		suffix.length,
		format,
		trim,
		getCount,
		{ reservedChars: suffix.length + 1 },
	)
	expect(memoryLargerThanBudget.payload.matches).toEqual([])
})
