import { expect, test } from 'vitest'
import {
	canonicalStatusOrigin,
	getLegacyStatusRedirectResponse,
	legacyStatusHost,
} from './legacy-redirect.ts'

test('legacy status host 308s page traffic to status.kody.codes and keeps /health sticky', () => {
	const page = getLegacyStatusRedirectResponse(
		new Request(`https://${legacyStatusHost}/?utm=x`),
	)
	expect(page?.status).toBe(308)
	expect(page?.headers.get('location')).toBe(`${canonicalStatusOrigin}/?utm=x`)

	const json = getLegacyStatusRedirectResponse(
		new Request(`https://${legacyStatusHost}/status.json`),
	)
	expect(json?.status).toBe(308)
	expect(json?.headers.get('location')).toBe(
		`${canonicalStatusOrigin}/status.json`,
	)

	const head = getLegacyStatusRedirectResponse(
		new Request(`https://${legacyStatusHost}/`, { method: 'HEAD' }),
	)
	expect(head?.status).toBe(308)
	expect(head?.headers.get('location')).toBe(`${canonicalStatusOrigin}/`)

	expect(
		getLegacyStatusRedirectResponse(
			new Request(`https://${legacyStatusHost}/health`),
		),
	).toBeNull()
	expect(
		getLegacyStatusRedirectResponse(
			new Request(`https://${legacyStatusHost}/health/extra`),
		),
	).toBeNull()

	expect(
		getLegacyStatusRedirectResponse(new Request('https://status.kody.codes/')),
	).toBeNull()
	expect(
		getLegacyStatusRedirectResponse(
			new Request(`https://${legacyStatusHost}/`, { method: 'POST' }),
		),
	).toBeNull()
})
