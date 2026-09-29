import { expect, test } from 'vitest'
import { baseMessage, rpcFor, uniqueUserId } from './mailbox-test-helpers.ts'

function makeMailbox(label: string) {
	const userId = uniqueUserId(label)
	const mailbox = rpcFor(userId)
	let sequence = 0
	return {
		mailbox,
		async insert(
			subject: string,
			fromAddress: string,
			extra: {
				envelopeFrom?: string
				direction?: 'outbound'
				inboxId?: string
			} = {},
		) {
			sequence += 1
			const message = baseMessage(userId, {
				subject,
				fromAddress,
				envelopeFrom: extra.envelopeFrom ?? null,
				direction: extra.direction ?? 'inbound',
				inboxId: extra.inboxId ?? null,
				createdAt: new Date(
					Date.parse('2026-07-01T00:00:00.000Z') + sequence * 1000,
				).toISOString(),
			})
			await mailbox.upsertMessageGraph({ ownerId: userId, message })
			return message.id
		},
		async searchIds(
			query: string,
			filters: {
				direction?: 'outbound'
				inboxId?: string
				limit?: number
			} = {},
		) {
			const { messages } = await mailbox.searchMessages({
				query,
				limit: 25,
				...filters,
			})
			return messages.map((message) => message.id)
		},
	}
}

test('Mailbox search matches subject, from address, and envelope sender case-insensitively', async () => {
	const { insert, searchIds } = makeMailbox('search')
	const bySubject = await insert(
		'Invoice #123 due Friday',
		'billing@acme.example',
	)
	const byFrom = await insert('Weekly digest', 'no-reply@invoices.example')
	const byEnvelope = await insert('Hello', 'friend@example.net', {
		envelopeFrom: 'bounce+invoice@mailer.example',
	})
	await insert('Unrelated', 'someone@example.net')
	expect(await searchIds('INVOICE')).toEqual([byEnvelope, byFrom, bySubject])
}, 30_000)

test('Mailbox search treats LIKE wildcards in the query literally', async () => {
	const { insert, searchIds } = makeMailbox('search-literals')
	const literalPercent = await insert('Save 100% today', 'deals@example.net')
	await insert('Save 100 dollars today', 'deals@example.net')
	const literalUnderscore = await insert(
		'snake_case release notes',
		'dev@example.net',
	)
	await insert('snakeXcase release notes', 'dev@example.net')

	expect(await searchIds('100%')).toEqual([literalPercent])
	expect(await searchIds('snake_case')).toEqual([literalUnderscore])
}, 30_000)

test('Mailbox search handles the former SQLite pattern boundary and long queries exactly', async () => {
	const { mailbox, insert, searchIds } = makeMailbox('search-pattern-limit')
	// DO SQLite caps LIKE/GLOB patterns at 50 bytes; `%…%` wrapping used to
	// fail once the wrapped pattern exceeded 50 bytes (KODY-CLOUDFLARE-3J).
	const queryAt49Characters = 'x'.repeat(49)
	const longQuery = `${'long-search-segment-'.repeat(256)}final`
	const at49MessageId = await insert(
		queryAt49Characters,
		'boundary@example.net',
	)
	const longMessageId = await insert(longQuery, 'long@example.net')

	expect(await searchIds('x'.repeat(48))).toEqual([at49MessageId])
	expect(await searchIds(queryAt49Characters)).toEqual([at49MessageId])
	expect(await searchIds(longQuery)).toEqual([longMessageId])
	expect(await searchIds(`${longQuery.slice(0, -1)}x`)).toEqual([])
	expect(await mailbox.countMessages({ query: longQuery })).toEqual({
		total: 1,
	})
}, 30_000)

test('Mailbox search applies filters and result limits', async () => {
	const { insert, searchIds } = makeMailbox('search-filters')
	const inboxId = `inbox-${crypto.randomUUID()}`
	const inboundInInbox = await insert(
		'Filtered report',
		'reports@example.net',
		{
			inboxId,
		},
	)
	const outbound = await insert('Filtered report reply', 'me@example.net', {
		direction: 'outbound',
	})
	const inboundElsewhere = await insert(
		'Filtered report elsewhere',
		'reports@example.net',
	)

	expect(await searchIds('filtered report', { direction: 'outbound' })).toEqual(
		[outbound],
	)
	expect(await searchIds('filtered report', { inboxId })).toEqual([
		inboundInInbox,
	])
	expect(await searchIds('filtered report', { limit: 2 })).toEqual([
		inboundElsewhere,
		outbound,
	])
}, 30_000)
