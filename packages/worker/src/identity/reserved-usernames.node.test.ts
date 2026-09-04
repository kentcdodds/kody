import { expect, test } from 'vitest'
import { dnsSafeUsernamePattern } from '@kody-internal/shared/public-urls.ts'
import { systemEmailLocals } from '#worker/email/system-email.ts'
import {
	builtInReservedUsernameList,
	getReservedUsernameError,
	isPermanentlyReservedUsername,
	isReservedUsername,
	isUsernameEffectivelyReserved,
	permanentlyReservedSystemLocals,
} from './reserved-usernames.ts'
import { getUsernameValidationError } from './username.ts'

test('reserved username list is sorted, unique, lowercase, and DNS-safe except legacy underscore locals', () => {
	const list = [...builtInReservedUsernameList]
	expect(list).toEqual(
		[...list].toSorted((left, right) => left.localeCompare(right)),
	)
	expect(new Set(list).size).toBe(list.length)
	for (const name of list) {
		expect(name).toBe(name.toLowerCase())
		if (name.includes('_')) continue
		expect(dnsSafeUsernamePattern.test(name)).toBe(true)
	}
	expect(permanentlyReservedSystemLocals).toEqual([...systemEmailLocals])
})

test('reserved username validation rejects brand, support, and infrastructure names', () => {
	for (const reserved of [
		'kody',
		'KODY',
		' support ',
		'postmaster',
		'no-reply',
		'admin',
		'mcp',
		'psl',
		'autodiscover',
		'mta-sts',
		'wpad',
		'kody-r-0123456789abcdef',
	]) {
		expect(isReservedUsername(reserved)).toBe(true)
		expect(getReservedUsernameError(reserved)).not.toBeNull()
		expect(getUsernameValidationError(reserved)).not.toBeNull()
	}

	for (const allowed of ['alice', 'assistant', 'analytics', 'robot']) {
		expect(isReservedUsername(allowed)).toBe(false)
		expect(getReservedUsernameError(allowed)).toBeNull()
		expect(getUsernameValidationError(allowed)).toBeNull()
	}

	expect(isReservedUsername('ab')).toBe(false)
	expect(getUsernameValidationError('ab')).not.toBeNull()
	expect(isPermanentlyReservedUsername('kody')).toBe(true)
	expect(isPermanentlyReservedUsername('support')).toBe(true)
	expect(isPermanentlyReservedUsername('kody-bot')).toBe(true)
	expect(isPermanentlyReservedUsername('kody-r-deadbeef')).toBe(true)
	expect(isPermanentlyReservedUsername('faq')).toBe(false)
	expect(isPermanentlyReservedUsername('alice')).toBe(false)

	expect(isUsernameEffectivelyReserved('faq', { removed: ['faq'] })).toBe(false)
	expect(
		isUsernameEffectivelyReserved('support', { removed: ['support'] }),
	).toBe(true)
	expect(
		isUsernameEffectivelyReserved('brandnew', { added: ['brandnew'] }),
	).toBe(true)
	expect(
		isUsernameEffectivelyReserved('brandnew', {
			added: ['brandnew'],
			removed: ['brandnew'],
		}),
	).toBe(false)

	expect(isReservedUsername('devnull')).toBe(true)
	expect(isReservedUsername('acmechallenge')).toBe(true)
	expect(isReservedUsername('developer')).toBe(false)
	expect(isReservedUsername('user-me')).toBe(false)
	expect(isReservedUsername('super-help')).toBe(false)
	expect(isReservedUsername('mcp-test-user')).toBe(false)

	const addedSwears = { added: ['fuck', 'ass'] }
	expect(isUsernameEffectivelyReserved('a-ss', addedSwears)).toBe(true)
	expect(isUsernameEffectivelyReserved('a_ss', addedSwears)).toBe(true)
	expect(isUsernameEffectivelyReserved('ass', addedSwears)).toBe(true)
	expect(isUsernameEffectivelyReserved('super-faq')).toBe(false)
	expect(isUsernameEffectivelyReserved('f-aq')).toBe(true)
	expect(isUsernameEffectivelyReserved('super-help')).toBe(false)
	expect(
		isUsernameEffectivelyReserved('super-help', { removed: ['help'] }),
	).toBe(false)
	expect(isUsernameEffectivelyReserved('kent-dodds-fan')).toBe(true)
	expect(isUsernameEffectivelyReserved('my-support-bot')).toBe(true)
})
