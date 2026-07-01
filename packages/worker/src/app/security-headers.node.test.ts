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

test('content security policy locks down scripts, framing, and base uri', () => {
	const csp = firstPartySecurityHeaders['Content-Security-Policy'] ?? ''
	expect(csp).toContain("script-src 'self'")
	// script-src must never allow inline scripts (the key XSS protection).
	expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
	expect(csp).toContain("frame-ancestors 'none'")
	expect(csp).toContain("base-uri 'self'")
	expect(csp).toContain("object-src 'none'")
	expect(csp).toContain("form-action 'self'")
})

test('sets clickjacking and sniffing protections', () => {
	expect(firstPartySecurityHeaders['X-Frame-Options']).toBe('DENY')
	expect(firstPartySecurityHeaders['X-Content-Type-Options']).toBe('nosniff')
})
