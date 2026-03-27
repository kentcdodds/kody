import { describe, expect, it } from 'vitest'

/**
 * Mirrors account-secrets handler readStringArray: non-strings are dropped.
 * JSON.stringify turns array holes/undefined entries into null, so a client
 * that serializes ['a', undefined] sends ["a",null] and the server keeps
 * only 'a' after filtering — matching the UI bug where a row looked filled
 * (stale DOM) but only one capability persisted.
 */
function readStringArray(body: Record<string, unknown>, key: string) {
	const value = body[key]
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === 'string')
}

describe('account secret save body parsing', () => {
	it('drops null elements produced from JSON undefined serialization', () => {
		const body = JSON.parse(
			JSON.stringify({
				allowedCapabilities: ['cloudflare_rest', undefined],
			}),
		) as Record<string, unknown>
		expect(body.allowedCapabilities).toEqual(['cloudflare_rest', null])
		expect(readStringArray(body, 'allowedCapabilities')).toEqual([
			'cloudflare_rest',
		])
	})

	it('keeps both capabilities when both are strings', () => {
		const body = {
			allowedCapabilities: ['cloudflare_rest', 'home_lutron_set_credentials'],
		}
		expect(readStringArray(body, 'allowedCapabilities')).toEqual([
			'cloudflare_rest',
			'home_lutron_set_credentials',
		])
	})
})
