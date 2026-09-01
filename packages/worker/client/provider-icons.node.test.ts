import { expect, test } from 'vitest'
import {
	resolveProviderIconId,
	resolveProviderMarkSource,
} from './provider-icons.tsx'

test('resolveProviderIconId matches exact keys, families, and authorize hosts', () => {
	// Algorithm samples (case, family prefix, alias, host suffix) — not a catalog lock.
	expect(resolveProviderIconId({ providerKey: 'GitHub' })).toBe('github')
	expect(resolveProviderIconId({ providerKey: 'google-youtube-brand' })).toBe(
		'google',
	)
	expect(resolveProviderIconId({ providerKey: 'work-slack' })).toBe('slack')
	expect(resolveProviderIconId({ providerKey: 'x-kodykoala' })).toBe('x')
	expect(resolveProviderIconId({ providerKey: 'twitter' })).toBe('x')
	expect(resolveProviderIconId({ providerKey: 'example' })).toBeNull()
	expect(resolveProviderIconId({ host: 'accounts.google.com' })).toBe('google')
	expect(resolveProviderIconId({ host: 'mcp.linear.app' })).toBe('linear')
	expect(
		resolveProviderIconId({
			providerKey: 'custom-crm',
			host: 'login.unknown.test',
		}),
	).toBeNull()
})

test('resolveProviderMarkSource prefers upload, then catalog, then favicon', () => {
	expect(
		resolveProviderMarkSource({
			logoPath: '/integrations/logos/dropbox?v=1',
			autoLogoPath: '/integrations/logos/dropbox?v=2',
			catalogLogoPath: '/integrations/provider-marks/dropbox?v=3',
		}),
	).toBe('upload')
	expect(
		resolveProviderMarkSource({
			autoLogoPath: '/integrations/logos/dropbox?v=2',
			catalogLogoPath: '/integrations/provider-marks/dropbox?v=3',
		}),
	).toBe('catalog')
	expect(
		resolveProviderMarkSource({
			autoLogoPath: '/integrations/logos/obscure-crm?v=2',
		}),
	).toBe('favicon')
	expect(
		resolveProviderMarkSource({
			catalogLogoPath: '/integrations/provider-marks/google?v=1',
		}),
	).toBe('catalog')
	expect(resolveProviderMarkSource({})).toBe('letter')
})
