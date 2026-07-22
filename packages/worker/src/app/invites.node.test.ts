import { expect, test } from 'vitest'
import {
	consumeInviteCode,
	createInvite,
	getInviteByCode,
	listInvites,
	type InviteRecord,
} from './invites.ts'

type InviteFixture = InviteRecord

function createInviteDb(invites: Array<InviteFixture> = []) {
	const records = new Map(invites.map((invite) => [invite.code, { ...invite }]))
	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			const createStatement = (params: Array<unknown>) => ({
				async run() {
					if (normalizedQuery.startsWith('insert into invites')) {
						const [code, createdBy, note, maxUses, expiresAt, plan] = params
						const invite: InviteFixture = {
							code: String(code),
							created_by: createdBy == null ? null : Number(createdBy),
							note: String(note ?? ''),
							max_uses: Number(maxUses),
							use_count: 0,
							expires_at: expiresAt == null ? null : String(expiresAt),
							revoked_at: null,
							created_at: '2026-07-05T00:00:00.000Z',
							plan: plan == null ? 'free' : String(plan),
						}
						records.set(invite.code, invite)
						return { meta: { changes: 1, last_row_id: 0 } }
					}
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
				async all() {
					if (
						normalizedQuery.startsWith('select') &&
						normalizedQuery.includes('from invites') &&
						normalizedQuery.includes('order by')
					) {
						const results = Array.from(records.values())
							.map((invite) => ({ ...invite }))
							.sort((left, right) => {
								if (left.created_at !== right.created_at) {
									return right.created_at.localeCompare(left.created_at)
								}
								return left.code.localeCompare(right.code)
							})
						return {
							results,
							meta: { changes: 0, last_row_id: 0 },
						}
					}
					return {
						results: [],
						meta: { changes: 0, last_row_id: 0 },
					}
				},
			})
			return {
				...createStatement([]),
				bind(...params: Array<unknown>) {
					return createStatement(params)
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
		plan: 'max',
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

test('createInvite stores plan and roundtrips through getInviteByCode and listInvites', async () => {
	const db = createInviteDb()
	const created = await createInvite({
		db,
		code: 'PLAN-PERSONAL',
		createdBy: 7,
		note: 'personal cohort',
		maxUses: 3,
		plan: 'pro',
	})

	expect(created.plan).toBe('pro')
	await expect(getInviteByCode(db, 'PLAN-PERSONAL')).resolves.toEqual(
		expect.objectContaining({
			code: 'PLAN-PERSONAL',
			plan: 'pro',
			max_uses: 3,
		}),
	)
	await expect(listInvites(db)).resolves.toEqual([
		expect.objectContaining({
			code: 'PLAN-PERSONAL',
			plan: 'pro',
		}),
	])
})

test('createInvite without plan stores free', async () => {
	const db = createInviteDb()
	const created = await createInvite({
		db,
		code: 'PLAN-NONE',
		createdBy: 7,
		maxUses: 1,
	})

	expect(created.plan).toBe('free')
	await expect(getInviteByCode(db, 'PLAN-NONE')).resolves.toEqual(
		expect.objectContaining({
			code: 'PLAN-NONE',
			plan: 'free',
		}),
	)
})
