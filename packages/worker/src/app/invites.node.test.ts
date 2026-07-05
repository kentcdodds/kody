import { expect, test } from 'vitest'
import { consumeInviteCode, type InviteRecord } from './invites.ts'

type InviteFixture = InviteRecord

function createInviteDb(invites: Array<InviteFixture>) {
	const records = new Map(invites.map((invite) => [invite.code, { ...invite }]))
	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async run() {
							if (
								normalizedQuery.startsWith('update invites') &&
								normalizedQuery.includes('set use_count = use_count + 1')
							) {
								const code = String(params[0] ?? '')
								const nowIso = String(params[1] ?? '')
								const invite = records.get(code)
								if (
									invite &&
									!invite.revoked_at &&
									(!invite.expires_at || invite.expires_at > nowIso) &&
									invite.use_count < invite.max_uses
								) {
									invite.use_count += 1
									return { meta: { changes: 1, last_row_id: 0 } }
								}
							}
							return { meta: { changes: 0, last_row_id: 0 } }
						},
						async first() {
							const code = String(params[0] ?? '')
							const invite = records.get(code)
							return invite ? { ...invite } : null
						},
					}
				},
			}
		},
		records,
	} as unknown as D1Database & { records: Map<string, InviteFixture> }
	return db
}

function invite(overrides: Partial<InviteFixture> = {}): InviteFixture {
	return {
		code: 'LAUNCH-ONE',
		created_by: 1,
		note: '',
		max_uses: 1,
		use_count: 0,
		expires_at: null,
		revoked_at: null,
		created_at: '2026-07-05T00:00:00.000Z',
		...overrides,
	}
}

test('consumeInviteCode rejects missing, unknown, expired, revoked, and exhausted codes', async () => {
	const now = new Date('2026-07-05T12:00:00.000Z')
	const db = createInviteDb([
		invite({ code: 'EXPIRED', expires_at: '2026-07-05T11:00:00.000Z' }),
		invite({ code: 'REVOKED', revoked_at: '2026-07-05T11:00:00.000Z' }),
		invite({ code: 'EXHAUSTED', use_count: 1, max_uses: 1 }),
	])

	await expect(consumeInviteCode({ db, code: '', now })).resolves.toEqual({
		ok: false,
		reason: 'missing',
	})
	await expect(
		consumeInviteCode({ db, code: 'unknown', now }),
	).resolves.toEqual({
		ok: false,
		reason: 'not_found',
	})
	await expect(
		consumeInviteCode({ db, code: 'expired', now }),
	).resolves.toEqual({
		ok: false,
		reason: 'expired',
	})
	await expect(
		consumeInviteCode({ db, code: 'revoked', now }),
	).resolves.toEqual({
		ok: false,
		reason: 'revoked',
	})
	await expect(
		consumeInviteCode({ db, code: 'exhausted', now }),
	).resolves.toEqual({
		ok: false,
		reason: 'exhausted',
	})
})

test('consumeInviteCode atomically prevents concurrent overuse', async () => {
	const now = new Date('2026-07-05T12:00:00.000Z')
	const db = createInviteDb([invite()])
	const results = await Promise.all([
		consumeInviteCode({ db, code: 'launch-one', now }),
		consumeInviteCode({ db, code: 'LAUNCH-ONE', now }),
	])

	expect(results.filter((result) => result.ok)).toHaveLength(1)
	expect(results.filter((result) => !result.ok)).toEqual([
		{ ok: false, reason: 'exhausted' },
	])
	expect(db.records.get('LAUNCH-ONE')?.use_count).toBe(1)
})
