import { expect, test } from 'vitest'
import {
	defaultDumpFile,
	formatContainsFailure,
	missingContainsNeedles,
	rawRequestBody,
} from './request-proof.ts'

test('request proof dumps raw bodies and reports missing HTML needles', () => {
	expect(defaultDumpFile()).toBe('.tmp/control-kody-body')
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
	expect(formatContainsFailure(['Waiting inbox'])).toBe(
		'response body does not contain "Waiting inbox"',
	)
})
