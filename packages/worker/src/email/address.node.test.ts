import { expect, test } from 'vitest'
import {
	extractReplyToken,
	findReplyTokenHash,
	getEmailDomain,
	getEmailLocalPart,
	hashReplyToken,
	normalizeEmailAddress,
	normalizeSubject,
	parseHeaderAddressList,
} from './address.ts'

test('email address helpers normalize mailbox strings and reply tokens', async () => {
	expect(normalizeEmailAddress('Alice Example <Alice@Example.COM>')).toBe(
		'alice@example.com',
	)
	expect(parseHeaderAddressList('A <a@example.com>, b@example.net')).toEqual([
		{ name: null, address: 'a@example.com' },
		{ name: null, address: 'b@example.net' },
	])
	expect(getEmailLocalPart('Support@Example.com')).toBe('support')
	expect(getEmailDomain('Support@Example.com')).toBe('example.com')
	expect(normalizeSubject(' Re:  Hello   world ')).toBe('hello world')

	const headers = new Headers({ 'X-Kody-Reply-Token': 'token-123' })
	expect(extractReplyToken({ headers, recipients: [] })).toBe('token-123')
	expect(await findReplyTokenHash({ headers, recipients: [] })).toBe(
		await hashReplyToken('token-123'),
	)
})
