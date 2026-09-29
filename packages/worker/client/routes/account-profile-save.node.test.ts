import { expect, test } from 'vitest'
import {
	interpretAccountProfileSave,
	readApiErrorMessage,
	usernameFormatError,
} from './account-profile-save.ts'

type SaveInput = Parameters<typeof interpretAccountProfileSave>[0]

const save = (
	requestedUsername: string,
	responseOk: boolean,
	payload: SaveInput['payload'],
	profileFieldsChanged = false,
) =>
	interpretAccountProfileSave({
		previousUsername: 'jklotz08',
		requestedUsername,
		profileFieldsChanged,
		responseOk,
		payload,
	})

test('failed username rename shows the server reason without success chrome', () => {
	expect(
		save('jklotz', false, { ok: false, error: '`jklotz` is taken.' }),
	).toEqual({ status: 'error', message: '`jklotz` is taken.' })

	const invalid = save('bad username', false, {
		ok: false,
		error:
			'Username must be 3 to 32 characters, use only letters, numbers, and hyphens, and start and end with a letter or number.',
	})
	expect(invalid.status).toBe('error')
	expect(invalid.message).toContain('3 to 32 characters')
	expect(invalid.message).not.toContain('Profile saved.')

	const rewriteError =
		'Username was not changed because package updates failed: sync failed'
	expect(save('jklotz', false, { ok: false, error: rewriteError })).toEqual({
		status: 'error',
		message: rewriteError,
	})
})

test('a 200 that did not persist the requested username is an error, not success', () => {
	expect(
		save('jklotz', true, { ok: true, username: 'jklotz08' }, true),
	).toEqual({
		status: 'error',
		message: '`jklotz` was not saved.',
	})
})

test('successful rename reports saved and an unchanged username does not', () => {
	expect(
		save('jklotz', true, {
			ok: true,
			username: 'jklotz',
			packageUpdateMessage: 'Updated 2 packages to the new @jklotz scope.',
		}),
	).toEqual({
		status: 'saved',
		message: 'Profile saved. Updated 2 packages to the new @jklotz scope.',
		appliedUsername: 'jklotz',
		usernameChanged: true,
	})
	expect(save('jklotz08', true, { ok: true, username: 'jklotz08' })).toEqual({
		status: 'noop',
		appliedUsername: 'jklotz08',
	})
	expect(
		save('JKLOTZ08', true, { ok: true, username: 'jklotz08' }, true),
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
