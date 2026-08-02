import { expect, test } from 'vitest'
import { classifyOutboundProviderIndexParity } from './outbound-provider-index.ts'

test('outbound provider parity classifier requires every canonical count', () => {
	expect(
		classifyOutboundProviderIndexParity({
			linkedMessageCount: 1,
			indexCount: 1,
			missingFromIndexCount: 0,
			missingFromMessagesCount: 0,
			mismatchedCount: 0,
		}),
	).toMatchObject({ parity: true })

	for (const mismatch of [
		{ linkedMessageCount: 2 },
		{ missingFromIndexCount: 1 },
		{ missingFromMessagesCount: 1 },
		{ mismatchedCount: 1 },
	]) {
		expect(
			classifyOutboundProviderIndexParity({
				linkedMessageCount: 1,
				indexCount: 1,
				missingFromIndexCount: 0,
				missingFromMessagesCount: 0,
				mismatchedCount: 0,
				...mismatch,
			}),
		).toMatchObject({ parity: false })
	}
})
