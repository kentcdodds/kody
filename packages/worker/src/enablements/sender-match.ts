import { normalizeEmailAddress } from '#worker/email/address.ts'
import { type InboundEmailSender } from '#worker/request-context/request-context.ts'
import { type EnablementSenderKind } from './types.ts'

/**
 * What an inbound message presents to a sender rule. `authenticated` is
 * DMARC pass or aligned SPF (`authenticatesFromAddress`), never DKIM alone.
 */
export type InboundSenderMatch = {
	sender: InboundEmailSender
	fromAddress: string | null
	authenticated: boolean
}

function fromDomain(fromAddress: string | null) {
	const normalized = fromAddress ? normalizeEmailAddress(fromAddress) : null
	if (!normalized) return null
	const at = normalized.lastIndexOf('@')
	return at === -1 ? null : normalized.slice(at + 1)
}

/**
 * Canonical form stored on enablements and used in the live unique index.
 * Address and domain are lowercased; `any_authenticated` drops the value.
 */
export function canonicalizeEnablementSender(input: {
	senderKind: EnablementSenderKind | null | undefined
	senderValue: string | null | undefined
}): { senderKind: EnablementSenderKind | null; senderValue: string | null } {
	const senderKind = input.senderKind ?? null
	if (!senderKind) return { senderKind: null, senderValue: null }
	switch (senderKind) {
		case 'any_authenticated':
			return { senderKind, senderValue: null }
		case 'member': {
			const value = input.senderValue?.trim().toLowerCase() ?? ''
			return { senderKind, senderValue: value.length > 0 ? value : null }
		}
		case 'address': {
			const value = input.senderValue
				? normalizeEmailAddress(input.senderValue)
				: null
			return { senderKind, senderValue: value }
		}
		case 'domain': {
			const value = input.senderValue?.trim().toLowerCase().replace(/^@+/, '')
			return {
				senderKind,
				senderValue: value && value.length > 0 ? value : null,
			}
		}
		default: {
			const exhaustive: never = senderKind
			throw new Error(`Unhandled enablement sender kind: ${String(exhaustive)}`)
		}
	}
}

/**
 * Whether one enablement's sender rule matches this inbound message.
 * A null `senderKind` never matches: unmatched mail stays in the inbox
 * and runs no package.
 */
export function enablementMatchesInboundSender(input: {
	senderKind: EnablementSenderKind | null
	senderValue: string | null
	match: InboundSenderMatch
}): boolean {
	const { senderKind, senderValue, match } = input
	if (!senderKind) return false
	switch (senderKind) {
		case 'member': {
			if (match.sender.kind !== 'member') return false
			if (!senderValue) return false
			return senderValue === String(match.sender.actor.userId)
		}
		case 'address': {
			if (!match.authenticated || !senderValue) return false
			const from = match.fromAddress
				? normalizeEmailAddress(match.fromAddress)
				: null
			const expected = normalizeEmailAddress(senderValue)
			return from !== null && expected !== null && from === expected
		}
		case 'domain': {
			if (!match.authenticated || !senderValue) return false
			const domain = fromDomain(match.fromAddress)
			return domain !== null && domain === senderValue.toLowerCase()
		}
		case 'any_authenticated':
			return match.authenticated
		default: {
			const exhaustive: never = senderKind
			throw new Error(`Unhandled enablement sender kind: ${String(exhaustive)}`)
		}
	}
}
