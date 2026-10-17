import { expect, test } from 'vitest'
import {
	assertEmailRecipientSendable,
	classifyRecipientDeliveryFailure,
	clearEmailRecipientCooldown,
	recordEmailRecipientCooldown,
} from './recipient-cooldown.ts'

function createCooldownDb() {
	const rows = new Map<
		string,
		{
			recipient: string
			class: string
			reason: string | null
			cooldown_until: string
			last_failure_at: string
			failure_count: number
		}
	>()
	return {
		rows,
		db: {
			prepare(sql: string) {
				return {
					bind(...binds: Array<unknown>) {
						return {
							async first<T>() {
								if (sql.includes('FROM email_recipient_cooldowns')) {
									const recipient = String(binds[0])
									return (rows.get(recipient) as T | undefined) ?? null
								}
								return null
							},
							async run() {
								if (sql.includes('INSERT INTO email_recipient_cooldowns')) {
									const recipient = String(binds[0])
									const existing = rows.get(recipient)
									rows.set(recipient, {
										recipient,
										class: String(binds[1]),
										reason: (binds[2] as string | null) ?? null,
										cooldown_until: String(binds[3]),
										last_failure_at: String(binds[4]),
										failure_count: existing ? existing.failure_count + 1 : 1,
									})
								}
								if (sql.includes('DELETE FROM email_recipient_cooldowns')) {
									rows.delete(String(binds[0]))
								}
								return { meta: { changes: 1 } }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
	}
}

test('blocklist deferred and failed classify as sender_block', () => {
	expect(
		classifyRecipientDeliveryFailure({
			status: 'deferred',
			smtpResponse: '451 4.7.1 kody.codes is blacklisted - RLR613',
		}),
	).toBe('sender_block')
	expect(
		classifyRecipientDeliveryFailure({
			status: 'failed',
			smtpResponse: 'Listed by DBL, see https://check.spamhaus.org',
		}),
	).toBe('sender_block')
	expect(
		classifyRecipientDeliveryFailure({
			status: 'deferred',
			smtpResponse: '450 mailbox busy',
		}),
	).toBeNull()
	expect(
		classifyRecipientDeliveryFailure({
			status: 'bounced',
			smtpResponse: '550 user unknown',
		}),
	).toBe('other')
})

test('recipient cooldown blocks sends until expiry', async () => {
	const { db } = createCooldownDb()
	const now = new Date('2026-10-17T12:00:00.000Z')
	await recordEmailRecipientCooldown({
		db,
		recipient: 'accounts+kody@coderunr.net',
		status: 'failed',
		smtpResponse: 'kody.codes is blacklisted - RLR613',
		now,
	})
	const blocked = await assertEmailRecipientSendable({
		db,
		recipient: 'Accounts+kody@coderunr.net',
		now,
	})
	expect(blocked).toMatchObject({
		ok: false,
		code: 'recipient_cooldown',
		class: 'sender_block',
	})
	expect(blocked.ok === false && blocked.message).toMatch(
		/blocking our domain/i,
	)

	const later = new Date('2026-10-18T13:00:00.000Z')
	expect(
		await assertEmailRecipientSendable({
			db,
			recipient: 'accounts+kody@coderunr.net',
			now: later,
		}),
	).toEqual({ ok: true })

	await clearEmailRecipientCooldown({
		db,
		recipient: 'accounts+kody@coderunr.net',
	})
})
