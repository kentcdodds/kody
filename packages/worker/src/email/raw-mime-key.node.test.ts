import { expect, test } from 'vitest'
import { emailRawMimeKey } from './repo.ts'

test('emailRawMimeKey is the canonical EMAIL_BLOBS raw-MIME object key', () => {
	expect(emailRawMimeKey('user-1', 'msg-1')).toBe('email-raw:v1:user-1/msg-1')
	expect(emailRawMimeKey('user-2', 'msg-1')).toBe('email-raw:v1:user-2/msg-1')
	expect(emailRawMimeKey('user-1', 'msg-2')).toBe('email-raw:v1:user-1/msg-2')
})
