import { expect, test } from 'vitest'
import {
	interpretAccountProfileSave,
	readApiErrorMessage,
	usernameFormatError,
} from './account-profile-save.ts'

test('failed username rename shows the server reason without success chrome', () => {
	const taken = interpretAccountProfileSave({
		previousUsername: 'jklotz08',
		requestedUsername: 'jklotz',
		profileFieldsChanged: false,
		responseOk: false,
		payload: { ok: false, error: '`jklotz` is taken.' },
	})
	expect(taken).toEqual({
		status: 'error',
		message: '`jklotz` is taken.',
	})
	expect(taken.message).not.toContain('Profile saved.')

	const invalid = interpretAccountProfileSave({
		previousUsername: 'jklotz08',
		requestedUsername: 'bad username',
		profileFieldsChanged: false,
		responseOk: false,
		payload: {
			ok: false,
			error:
				'Username must be 3 to 32 characters, use only letters, numbers, and hyphens, and start and end with a letter or number.',
		},
	})
	expect(invalid.status).toBe('error')
	expect(invalid.message).toContain('3 to 32 characters')
	expect(invalid.message).not.toContain('Profile saved.')

	const rewriteFailed = interpretAccountProfileSave({
		previousUsername: 'jklotz08',
		requestedUsername: 'jklotz',
		profileFieldsChanged: false,
		responseOk: false,
		payload: {
			ok: false,
			error:
				'Username was not changed because package updates failed: sync failed',
		},
	})
	expect(rewriteFailed).toEqual({
		status: 'error',
		message:
			'Username was not changed because package updates failed: sync failed',
	})
	expect(rewriteFailed.message).not.toContain('Profile saved.')
})

test('a 200 that did not persist the requested username is an error, not success', () => {
	const result = interpretAccountProfileSave({
		previousUsername: 'jklotz08',
		requestedUsername: 'jklotz',
		profileFieldsChanged: true,
		responseOk: true,
		payload: { ok: true, username: 'jklotz08' },
	})
	expect(result).toEqual({
		status: 'error',
		message: '`jklotz` was not saved.',
	})
	expect(result.message).not.toContain('Profile saved.')
})

test('successful rename reports saved and an unchanged username does not', () => {
	expect(
		interpretAccountProfileSave({
			previousUsername: 'jklotz08',
			requestedUsername: 'jklotz',
			profileFieldsChanged: false,
			responseOk: true,
			payload: {
				ok: true,
				username: 'jklotz',
				packageUpdateMessage: 'Updated 2 packages to the new @jklotz scope.',
			},
		}),
	).toEqual({
		status: 'saved',
		message: 'Profile saved. Updated 2 packages to the new @jklotz scope.',
		appliedUsername: 'jklotz',
		usernameChanged: true,
	})

	expect(
		interpretAccountProfileSave({
			previousUsername: 'jklotz08',
			requestedUsername: 'jklotz08',
			profileFieldsChanged: false,
			responseOk: true,
			payload: { ok: true, username: 'jklotz08' },
		}),
	).toEqual({
		status: 'noop',
		appliedUsername: 'jklotz08',
	})

	expect(
		interpretAccountProfileSave({
			previousUsername: 'jklotz08',
			requestedUsername: 'JKLOTZ08',
			profileFieldsChanged: true,
			responseOk: true,
			payload: { ok: true, username: 'jklotz08' },
		}),
	).toMatchObject({
		status: 'saved',
		message: 'Profile saved.',
		usernameChanged: false,
	})
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

test('username format errors stay next to the field while typing', () => {
	expect(usernameFormatError('jklotz')).toBeNull()
	expect(usernameFormatError('bad username')).toMatch(/3 to 32/)
	expect(usernameFormatError('')).toBe('Username is required.')
})
