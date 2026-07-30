import { expect, test } from 'vitest'
import { synthesizeDomainId } from './domain-id.ts'

test('domain ids preserve safe names and stably disambiguate lossy names', () => {
	expect(
		synthesizeDomainId({
			namespace: 'mcp',
			value: 'linear',
			fallback: 'server',
		}),
	).toEqual({ domainId: 'mcp:linear', kodyName: 'linear' })

	const first = synthesizeDomainId({
		namespace: 'openapi',
		value: 'Provider Name',
		fallback: 'provider',
	})
	const second = synthesizeDomainId({
		namespace: 'openapi',
		value: 'Provider Name',
		fallback: 'provider',
	})
	expect(first).toEqual(second)
	expect(first.domainId).toBe(`openapi:${first.kodyName}`)
	expect(first.kodyName).toMatch(/^Provider_Name_[0-9a-f]{8}$/)
})
