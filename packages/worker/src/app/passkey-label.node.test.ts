import { expect, test } from 'vitest'
import {
	buildDefaultPasskeyName,
	getAuthenticatorName,
	describeUserAgentPlatform,
	validatePasskeyName,
	passkeyNameMaxLength,
} from './passkey-label.ts'

test('passkey labels compose provider/platform defaults and validate rename input', () => {
	expect(getAuthenticatorName('ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4')).toBe(
		'Google Password Manager',
	)
	expect(getAuthenticatorName('00000000-0000-0000-0000-000000000000')).toBe(
		undefined,
	)
	expect(getAuthenticatorName('not-a-real-aaguid')).toBe(undefined)
	expect(getAuthenticatorName('toString')).toBe(undefined)

	expect(
		describeUserAgentPlatform(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
		),
	).toBe('macOS')
	expect(describeUserAgentPlatform(null)).toBe(undefined)

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
