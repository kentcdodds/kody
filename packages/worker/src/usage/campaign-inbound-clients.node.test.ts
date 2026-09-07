import { expect, test } from 'vitest'
import { countDistinctInboundClientIds } from './campaign-inbound-clients.ts'

test('distinct inbound clientIds page every grant and do not treat grant count as clients', async () => {
	expect(await countDistinctInboundClientIds(undefined, 'user-1')).toEqual({
		uniqueClientCount: 0,
		listingFailed: false,
	})

	const pages = [
		{
			items: [
				{ id: 'g1', clientId: 'cursor', scope: [] },
				{ id: 'g2', clientId: 'cursor', scope: [] },
				{ id: 'g3', clientId: '  ', scope: [] },
			],
			cursor: 'page-2',
		},
		{
			items: [
				{ id: 'g4', clientId: 'claude', scope: [] },
				{ id: 'g5', clientId: 'cursor', scope: [] },
			],
		},
	]
	let calls = 0
	const helpers = {
		async listUserGrants(_userId: string, options?: { cursor?: string }) {
			calls += 1
			if (options?.cursor === 'page-2') return pages[1]!
			return pages[0]!
		},
	}

	expect(await countDistinctInboundClientIds(helpers, 'user-1')).toEqual({
		uniqueClientCount: 2,
		listingFailed: false,
	})
	expect(calls).toBe(2)

	const failing = {
		async listUserGrants() {
			throw new Error('kv down')
		},
	}
	expect(await countDistinctInboundClientIds(failing, 'user-1')).toEqual({
		uniqueClientCount: 0,
		listingFailed: true,
	})
})
