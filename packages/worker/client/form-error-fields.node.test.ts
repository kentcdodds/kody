import { expect, test } from 'vitest'
import {
	fieldErrorProps,
	invalidFieldsForMessage,
} from './form-error-fields.ts'

test('credential errors mark email and password; named errors mark that field', () => {
	expect(
		invalidFieldsForMessage('error', 'Invalid email or password.', [
			'email',
			'password',
		]),
	).toEqual(new Set(['email', 'password']))
	expect(
		invalidFieldsForMessage('error', 'Username is required.', [
			'email',
			'password',
		]),
	).toEqual(new Set(['username']))
	expect(
		invalidFieldsForMessage('error', 'Invite code is invalid.', [
			'email',
			'password',
		]),
	).toEqual(new Set(['inviteCode']))
	expect(
		invalidFieldsForMessage(
			'error',
			'Password must be at least 8 characters.',
			['email', 'password'],
		),
	).toEqual(new Set(['password']))
	expect(
		invalidFieldsForMessage('error', 'Email already registered.', [
			'email',
			'password',
		]),
	).toEqual(new Set(['email']))
	expect(
		invalidFieldsForMessage('idle', 'Invalid email or password.', []),
	).toEqual(new Set())
})

test('waitlist errors mark first name, email, or both', () => {
	expect(
		invalidFieldsForMessage('error', 'First name and email are required.', [
			'firstName',
			'email',
		]),
	).toEqual(new Set(['firstName', 'email']))
	expect(
		invalidFieldsForMessage('error', 'What should we call you?', [
			'firstName',
			'email',
		]),
	).toEqual(new Set(['firstName']))
	expect(
		invalidFieldsForMessage(
			'error',
			"That email doesn't look complete. Mind checking it?",
			['firstName', 'email'],
		),
	).toEqual(new Set(['email']))
})

test('fieldErrorProps only attach when that field is invalid', () => {
	const invalid = new Set(['email'] as const)
	expect(fieldErrorProps('email', invalid, 'status')).toEqual({
		'aria-invalid': 'true',
		'aria-describedby': 'status',
	})
	expect(fieldErrorProps('password', invalid, 'status')).toEqual({})
})
