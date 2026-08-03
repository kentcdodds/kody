import { expect, test } from 'vitest'
import { classifyOutboundProviderIndexParity } from './outbound-provider-index.ts'

test('outbound provider index structural report fails only for malformed rows', () => {
	expect(
		classifyOutboundProviderIndexParity({
			indexCount: 1,
			distinctOwnerCount: 1,
			malformedCount: 0,
		}),
	).toMatchObject({ parity: true })

	expect(
		classifyOutboundProviderIndexParity({
			indexCount: 2,
			distinctOwnerCount: 1,
			malformedCount: 1,
		}),
	).toMatchObject({ parity: false })
})
