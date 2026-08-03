import { expect, test } from 'vitest'
import { classifyOutboundProviderIndexHealth } from './outbound-provider-index.ts'

test('outbound provider index structural report fails only for malformed rows', () => {
	expect(
		classifyOutboundProviderIndexHealth({
			indexCount: 1,
			distinctOwnerCount: 1,
			malformedCount: 0,
		}),
	).toMatchObject({ healthy: true })

	expect(
		classifyOutboundProviderIndexHealth({
			indexCount: 2,
			distinctOwnerCount: 1,
			malformedCount: 1,
		}),
	).toMatchObject({ healthy: false })
})
