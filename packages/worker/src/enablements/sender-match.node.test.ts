import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import {
	enablementMatchesInboundSender,
	type InboundSenderMatch,
} from './sender-match.ts'

const beaId = personIdFromStored('bea')

const memberMatch: InboundSenderMatch = {
	sender: {
		kind: 'member',
		actor: { userId: beaId, username: 'bea' },
		role: 'member',
	},
	fromAddress: 'Bea <bea@acme.example>',
	authenticated: true,
}

const externalMatch: InboundSenderMatch = {
	sender: { kind: 'inbox-owner' },
	fromAddress: 'Receipts <receipts@shop.example>',
	authenticated: true,
}

test('a null sender kind never matches', () => {
	expect(
		enablementMatchesInboundSender({
			senderKind: null,
			senderValue: null,
			match: externalMatch,
		}),
	).toBe(false)
})

test('member rules match only that classified person', () => {
	expect(
		enablementMatchesInboundSender({
			senderKind: 'member',
			senderValue: beaId,
			match: memberMatch,
		}),
	).toBe(true)
	expect(
		enablementMatchesInboundSender({
			senderKind: 'member',
			senderValue: 'someone-else',
			match: memberMatch,
		}),
	).toBe(false)
	expect(
		enablementMatchesInboundSender({
			senderKind: 'member',
			senderValue: beaId,
			match: externalMatch,
		}),
	).toBe(false)
})

test('address, domain, and any_authenticated require an authenticated From', () => {
	const dkimOnly: InboundSenderMatch = {
		...externalMatch,
		authenticated: false,
	}
	for (const senderKind of [
		'address',
		'domain',
		'any_authenticated',
	] as const) {
		expect(
			enablementMatchesInboundSender({
				senderKind,
				senderValue:
					senderKind === 'domain' ? 'shop.example' : 'receipts@shop.example',
				match: dkimOnly,
			}),
			senderKind,
		).toBe(false)
	}
	expect(
		enablementMatchesInboundSender({
			senderKind: 'address',
			senderValue: 'receipts@shop.example',
			match: externalMatch,
		}),
	).toBe(true)
	expect(
		enablementMatchesInboundSender({
			senderKind: 'address',
			senderValue: 'other@shop.example',
			match: externalMatch,
		}),
	).toBe(false)
	expect(
		enablementMatchesInboundSender({
			senderKind: 'domain',
			senderValue: 'shop.example',
			match: externalMatch,
		}),
	).toBe(true)
	expect(
		enablementMatchesInboundSender({
			senderKind: 'domain',
			senderValue: 'SHOP.EXAMPLE',
			match: externalMatch,
		}),
	).toBe(true)
	expect(
		enablementMatchesInboundSender({
			senderKind: 'domain',
			senderValue: 'example',
			match: externalMatch,
		}),
	).toBe(false)
	expect(
		enablementMatchesInboundSender({
			senderKind: 'any_authenticated',
			senderValue: null,
			match: externalMatch,
		}),
	).toBe(true)
})
