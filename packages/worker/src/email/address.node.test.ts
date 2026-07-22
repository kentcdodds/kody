import { expect, test } from 'vitest'
import {
	getEmailDomain,
	getEmailLocalPart,
	normalizeEmailAddress,
	normalizeSubject,
	parseHeaderAddressList,
	splitEmailLocalPart,
} from './address.ts'

test('email address helpers normalize mailbox strings', () => {
	expect(normalizeEmailAddress('Alice Example <Alice@Example.COM>')).toBe(
		'alice@example.com',
	)
	expect(parseHeaderAddressList('A <a@example.com>, b@example.net')).toEqual([
		{ name: null, address: 'a@example.com' },
		{ name: null, address: 'b@example.net' },
	])
	expect(getEmailLocalPart('Support@Example.com')).toBe('support')
	expect(getEmailDomain('Support@Example.com')).toBe('example.com')
	expect(normalizeSubject(' Re: Fwd:  Hello   world ')).toBe('hello world')

	expect(splitEmailLocalPart('kentcdodds')).toEqual({
		base: 'kentcdodds',
		subaddress: null,
	})
	expect(splitEmailLocalPart('kentcdodds+billing')).toEqual({
		base: 'kentcdodds',
		subaddress: 'billing',
	})
	expect(splitEmailLocalPart('kentcdodds+a+b')).toEqual({
		base: 'kentcdodds',
		subaddress: 'a+b',
	})
	expect(splitEmailLocalPart('kentcdodds+')).toEqual({
		base: 'kentcdodds',
		subaddress: null,
	})
	expect(splitEmailLocalPart('+tag')).toEqual({ base: '', subaddress: 'tag' })
})
