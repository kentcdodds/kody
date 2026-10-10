import { expect, test } from 'vitest'
import {
	interpretAccountProfileSave,
	readApiErrorMessage,
} from './account-profile-save.ts'

test('a failed save shows the server reason without success chrome', () => {
	expect(
		interpretAccountProfileSave({
			profileFieldsChanged: true,
			responseOk: false,
			payload: { ok: false, error: 'Bio is too long.' },
		}),
	).toEqual({ status: 'error', message: 'Bio is too long.' })
	expect(
		interpretAccountProfileSave({
			profileFieldsChanged: true,
			responseOk: true,
			payload: null,
		}),
	).toEqual({ status: 'error', message: 'Unable to save profile.' })
})

test('a save with no changed fields is a no-op and a changed one reports saved', () => {
	expect(
		interpretAccountProfileSave({
			profileFieldsChanged: false,
			responseOk: true,
			payload: { ok: true },
		}),
	).toEqual({ status: 'noop' })
	expect(
		interpretAccountProfileSave({
			profileFieldsChanged: true,
			responseOk: true,
			payload: { ok: true },
		}),
	).toEqual({ status: 'saved', message: 'Profile saved.' })
})

test('readApiErrorMessage accepts string or nested envelope errors', () => {
	expect(readApiErrorMessage({ error: '`jklotz` is taken.' }, 'fallback')).toBe(
		'`jklotz` is taken.',
	)
	expect(
		readApiErrorMessage(
			{ error: { code: 'account_deleting', message: 'Writes are disabled.' } },
			'fallback',
		),
	).toBe('Writes are disabled.')
	expect(readApiErrorMessage(null, 'Unable to save profile.')).toBe(
		'Unable to save profile.',
	)
})
