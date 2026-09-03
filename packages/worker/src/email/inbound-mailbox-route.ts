import { isPermanentlyReservedUsername } from '#worker/identity/reserved-usernames.ts'
import { normalizeEmailAddress, splitEmailLocalPart } from './address.ts'
import { isSystemEmailLocal, type SystemEmailLocal } from './system-email.ts'

export type InboundMailboxRoute =
	| {
			kind: 'reject'
			reason: string
	  }
	| {
			kind: 'system'
			recipient: string
			localBase: SystemEmailLocal
			systemDomain: string
	  }
	| {
			kind: 'user'
			recipient: string
			username: string
	  }

/**
 * Classify an inbound envelope recipient as operator system mail, user
 * inbox mail, or a permanent reject.
 *
 * RFC 5233 plus-tags are stripped before reserved, system-local, and
 * username matching. `user+kody@inbox…` (and `+support`, `+admin`, …) is
 * user mail for `user` when that username exists — never the reserved
 * apex local `kody`. The plus-tag is not consulted for those checks.
 * Callers keep the full tagged `recipient` on stored `to_addresses`.
 *
 * Do not reuse the username-claim denylist
 * (`usernameCollidesWithReservedNames` / `isReservedUsername`) on a
 * tagged local: that matcher substring-matches brand/system roots, so
 * `alice+kody` would look reserved even though the mailbox owner is
 * `alice`.
 */
export function resolveInboundMailboxRoute(input: {
	envelopeTo: string
	acceptedUserDomains: ReadonlyArray<string>
	acceptedSystemDomains: ReadonlyArray<string>
	systemDomain: string | null
}): InboundMailboxRoute {
	const recipient = normalizeEmailAddress(input.envelopeTo)
	if (!recipient) {
		return { kind: 'reject', reason: 'Invalid recipient address.' }
	}
	if (
		input.acceptedUserDomains.length === 0 &&
		input.acceptedSystemDomains.length === 0
	) {
		return { kind: 'reject', reason: 'Email routing is not configured.' }
	}

	const atIndex = recipient.lastIndexOf('@')
	const localPart = recipient.slice(0, atIndex)
	const recipientDomain = recipient.slice(atIndex + 1)
	const { base: localBase } = splitEmailLocalPart(localPart)

	if (
		input.systemDomain &&
		input.acceptedSystemDomains.includes(recipientDomain) &&
		isSystemEmailLocal(localBase)
	) {
		return {
			kind: 'system',
			recipient,
			localBase,
			systemDomain: input.systemDomain,
		}
	}
	if (!input.acceptedUserDomains.includes(recipientDomain)) {
		return { kind: 'reject', reason: 'Unknown Kody email address.' }
	}
	if (isPermanentlyReservedUsername(localBase)) {
		return {
			kind: 'reject',
			reason: 'This address is reserved for system mail.',
		}
	}
	return { kind: 'user', recipient, username: localBase }
}
