import { expect, test } from 'vitest'
import {
	builtInReservedUsernameList,
	isPermanentlyReservedUsername,
	usernameCollidesWithReservedNames,
} from '#worker/identity/reserved-usernames.ts'
import { normalizeEmailAddress, splitEmailLocalPart } from './address.ts'
import { resolveInboundMailboxRoute } from './inbound-mailbox-route.ts'
import { systemEmailLocals } from './system-email.ts'

const userDomain = 'inbox.kody.codes'
const heykodyUserDomain = 'inbox.heykody.app'
const systemDomain = 'kody.codes'

function routeFor(envelopeTo: string) {
	return resolveInboundMailboxRoute({
		envelopeTo,
		acceptedUserDomains: [userDomain, heykodyUserDomain],
		acceptedSystemDomains: [systemDomain],
		systemDomain,
	})
}

test('plus tags on user inbox hosts are never reserved system locals', () => {
	expect(normalizeEmailAddress('kentcdodds+kody@inbox.kody.codes')).toBe(
		'kentcdodds+kody@inbox.kody.codes',
	)
	expect(normalizeEmailAddress('Kent <alice+Kody@Inbox.Kody.CODES>')).toBe(
		'alice+kody@inbox.kody.codes',
	)
	expect(splitEmailLocalPart('kentcdodds+kody')).toEqual({
		base: 'kentcdodds',
		subaddress: 'kody',
	})
	expect(splitEmailLocalPart('alice+patch')).toEqual({
		base: 'alice',
		subaddress: 'patch',
	})

	// The username-claim denylist substring-matches brand/system roots, so
	// the full tagged local looks reserved. Inbound routing must not use
	// that matcher on the tagged local or the plus-tag.
	expect(
		usernameCollidesWithReservedNames(
			'alice+kody',
			builtInReservedUsernameList,
		),
	).toBe(true)
	expect(isPermanentlyReservedUsername('alice')).toBe(false)
	expect(isPermanentlyReservedUsername('alice+kody')).toBe(false)

	expect(routeFor('alice+kody@inbox.kody.codes')).toEqual({
		kind: 'user',
		recipient: 'alice+kody@inbox.kody.codes',
		username: 'alice',
	})
	expect(routeFor('alice+patch@inbox.kody.codes')).toEqual({
		kind: 'user',
		recipient: 'alice+patch@inbox.kody.codes',
		username: 'alice',
	})
	expect(routeFor('Alice+Support@inbox.heykody.app')).toEqual({
		kind: 'user',
		recipient: 'alice+support@inbox.heykody.app',
		username: 'alice',
	})

	for (const tag of systemEmailLocals) {
		expect(routeFor(`alice+${tag}@${userDomain}`)).toEqual({
			kind: 'user',
			recipient: `alice+${tag}@${userDomain}`,
			username: 'alice',
		})
	}

	expect(routeFor(`kody@${systemDomain}`)).toEqual({
		kind: 'system',
		recipient: `kody@${systemDomain}`,
		localBase: 'kody',
		systemDomain,
	})
	expect(routeFor(`support+ticket-123@${systemDomain}`)).toEqual({
		kind: 'system',
		recipient: `support+ticket-123@${systemDomain}`,
		localBase: 'support',
		systemDomain,
	})
	expect(routeFor(`kody@${userDomain}`)).toEqual({
		kind: 'reject',
		reason: 'This address is reserved for system mail.',
	})
	expect(routeFor(`kody+tag@${userDomain}`)).toEqual({
		kind: 'reject',
		reason: 'This address is reserved for system mail.',
	})
	expect(routeFor(`alice@${systemDomain}`)).toEqual({
		kind: 'reject',
		reason: 'Unknown Kody email address.',
	})
	expect(routeFor('not-an-address')).toEqual({
		kind: 'reject',
		reason: 'Invalid recipient address.',
	})
})
