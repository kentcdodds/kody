import { expect, test } from 'vitest'
import {
	emailRejectingProviderTtlMs,
	listActiveRejectingProviders,
} from './rejecting-providers.ts'

test('SQLite-style seed timestamps stay active across UTC midnight for a full TTL', async () => {
	const seedAt = '2026-10-17 12:00:00'
	const rows = {
		results: [
			{
				provider_key: 'messagingengine.com',
				last_rejection_at: seedAt,
				rejection_count: 1,
				last_recipient_domain: null,
				seeded: 1,
			},
		],
	}
	const db = {
		prepare() {
			return {
				bind() {
					return this
				},
				async all() {
					return rows
				},
			}
		},
	} as unknown as D1Database

	const justAfterMidnight = new Date('2026-10-18T00:30:00.000Z')
	const active = await listActiveRejectingProviders({
		db,
		now: justAfterMidnight,
	})
	expect(active.map((row) => row.providerKey)).toEqual(['messagingengine.com'])

	const afterTtl = new Date(
		Date.parse('2026-10-17T12:00:00.000Z') + emailRejectingProviderTtlMs + 1,
	)
	expect(await listActiveRejectingProviders({ db, now: afterTtl })).toEqual([])
})
