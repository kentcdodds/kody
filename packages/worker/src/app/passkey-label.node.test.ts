import { expect, test } from 'vitest'
import {
	buildDefaultPasskeyName,
	getAuthenticatorName,
	describeUserAgentPlatform,
	validatePasskeyName,
	passkeyNameMaxLength,
} from './passkey-label.ts'

test('getAuthenticatorName maps common providers and ignores anonymous AAGUIDs', () => {
	expect(getAuthenticatorName('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4')).toBe(
		'Google Password Manager',
	)
	expect(getAuthenticatorName('BADA5566-A7AA-401F-BD96-45619A55120D')).toBe(
		'1Password',
	)
	expect(getAuthenticatorName('fbfc3007-154e-4ecc-8c0b-6e020557d7bd')).toBe(
		'Apple Passwords',
	)
	expect(getAuthenticatorName('2fc0579f-8113-47ea-b116-bb5a8db9202a')).toBe(
		'YubiKey 5 NFC',
	)
	expect(getAuthenticatorName('00000000-0000-0000-0000-000000000000')).toBe(
		undefined,
	)
	expect(getAuthenticatorName('not-a-real-aaguid')).toBe(undefined)
	expect(getAuthenticatorName('toString')).toBe(undefined)
})

test('describeUserAgentPlatform extracts common platforms', () => {
	expect(
		describeUserAgentPlatform(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
		),
	).toBe('macOS')
	expect(
		describeUserAgentPlatform(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
		),
	).toBe('iPhone')
	expect(
		describeUserAgentPlatform(
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
		),
	).toBe('Windows')
	expect(
		describeUserAgentPlatform(
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
		),
	).toBe('Linux')
	expect(describeUserAgentPlatform(null)).toBe(undefined)
})

test('buildDefaultPasskeyName prefers provider and includes platform when useful', () => {
	expect(
		buildDefaultPasskeyName({
			aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
			deviceType: 'multiDevice',
			userAgent:
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
		}),
	).toBe('Google Password Manager · macOS')

	expect(
		buildDefaultPasskeyName({
			aaguid: '00000000-0000-0000-0000-000000000000',
			deviceType: 'multiDevice',
			userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
		}),
	).toBe('Synced passkey · Linux')

	expect(
		buildDefaultPasskeyName({
			aaguid: '00000000-0000-0000-0000-000000000000',
			deviceType: 'singleDevice',
			userAgent: null,
		}),
	).toBe('Device-bound passkey')
})

test('validatePasskeyName trims and enforces length', () => {
	expect(validatePasskeyName('  Work laptop  ')).toEqual({
		ok: true,
		name: 'Work laptop',
	})
	expect(validatePasskeyName('')).toEqual({
		ok: false,
		error: 'Name is required.',
	})
	expect(validatePasskeyName('   ')).toEqual({
		ok: false,
		error: 'Name is required.',
	})
	expect(validatePasskeyName('x'.repeat(passkeyNameMaxLength + 1))).toEqual({
		ok: false,
		error: `Name must be ${passkeyNameMaxLength} characters or fewer.`,
	})
})
