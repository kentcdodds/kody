import { expect, test } from 'vitest'
import { resolveProviderIconId } from './provider-icons.tsx'

test('resolveProviderIconId matches exact keys, families, and authorize hosts', () => {
	expect(resolveProviderIconId({ providerKey: 'GitHub' })).toBe('github')
	expect(resolveProviderIconId({ providerKey: 'google-youtube-brand' })).toBe(
		'google',
	)
	expect(resolveProviderIconId({ providerKey: 'work-slack' })).toBe('slack')
	expect(resolveProviderIconId({ providerKey: 'x-kodykoala' })).toBe('x')
	expect(resolveProviderIconId({ providerKey: 'twitter' })).toBe('x')
	expect(resolveProviderIconId({ providerKey: 'example' })).toBeNull()
	expect(resolveProviderIconId({ host: 'accounts.google.com' })).toBe('google')
	expect(resolveProviderIconId({ host: 'www.googleapis.com' })).toBe('google')
	expect(resolveProviderIconId({ host: 'github.com' })).toBe('github')
	expect(
		resolveProviderIconId({
			providerKey: 'custom-crm',
			host: 'login.unknown.test',
		}),
	).toBeNull()
})
