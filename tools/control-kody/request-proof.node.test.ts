import { expect, test } from 'vitest'
import { missingContainsNeedles, rawRequestBody } from './request-proof.ts'

test('request proof dumps raw bodies and reports missing HTML needles', () => {
	expect(rawRequestBody({ items: [] })).toBe('{"items":[]}')
	expect(
		missingContainsNeedles('<main>Waiting inbox</main>', [
			'Waiting inbox',
			'Missing heading',
		]),
	).toEqual(['Missing heading'])
	expect(
		missingContainsNeedles('<main>Waiting inbox</main>', ['Waiting']),
	).toEqual([])
})
