import { expect, test } from 'vitest'
import {
	assertUserEmailGraphAuthority,
	loadUserEmailGraphAuthorityMarker,
} from './user-email-graph-authority.ts'

function dbWithMarker(
	row: {
		owner_count: number
		frozen_at: string
		max_parity_age_hours: number
	} | null,
) {
	return {
		prepare() {
			return {
				async first() {
					return row
				},
			}
		},
	} as unknown as D1Database
}

test('USER writes require the authority marker while system writes are unaffected', async () => {
	await expect(
		assertUserEmailGraphAuthority({
			db: dbWithMarker(null),
			ownerId: 'user-1',
		}),
	).rejects.toThrow(/cutover marker is missing/)
	await expect(
		assertUserEmailGraphAuthority({
			db: dbWithMarker(null),
			ownerId: 'system:email',
		}),
	).resolves.toBeUndefined()
	const db = dbWithMarker({
		owner_count: 12,
		frozen_at: '2026-08-03T00:00:00.000Z',
		max_parity_age_hours: 6,
	})
	await expect(
		assertUserEmailGraphAuthority({ db, ownerId: 'user-1' }),
	).resolves.toBeUndefined()
	await expect(loadUserEmailGraphAuthorityMarker(db)).resolves.toEqual({
		ownerCount: 12,
		frozenAt: '2026-08-03T00:00:00.000Z',
		maxParityAgeHours: 6,
	})
})
