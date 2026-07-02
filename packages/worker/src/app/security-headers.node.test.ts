import { expect, test } from 'vitest'
import {
	applyFirstPartySecurityHeaders,
	firstPartySecurityHeaders,
} from './security-headers.ts'

test('applies the full first-party security header set to a response', () => {
	const response = applyFirstPartySecurityHeaders(new Response('ok'))
	for (const [name, value] of Object.entries(firstPartySecurityHeaders)) {
		expect(response.headers.get(name)).toBe(value)
	}
})
