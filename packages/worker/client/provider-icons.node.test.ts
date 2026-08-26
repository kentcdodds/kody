import { expect, test } from 'vitest'
import {
	resolveProviderIconId,
	resolveProviderMarkSource,
} from './provider-icons.tsx'

test('resolveProviderIconId matches exact keys, families, and authorize hosts', () => {
	expect(resolveProviderIconId({ providerKey: 'GitHub' })).toBe('github')
	expect(resolveProviderIconId({ providerKey: 'google-youtube-brand' })).toBe(
		'google',
	)
	expect(resolveProviderIconId({ providerKey: 'work-slack' })).toBe('slack')
	expect(resolveProviderIconId({ providerKey: 'x-kodykoala' })).toBe('x')
	expect(resolveProviderIconId({ providerKey: 'twitter' })).toBe('x')
	expect(resolveProviderIconId({ providerKey: 'xero' })).toBe('xero')
	expect(resolveProviderIconId({ providerKey: 'dropbox' })).toBe('dropbox')
	expect(resolveProviderIconId({ providerKey: 'producthunt' })).toBe(
		'producthunt',
	)
	expect(resolveProviderIconId({ providerKey: 'example' })).toBeNull()
	expect(resolveProviderIconId({ host: 'accounts.google.com' })).toBe('google')
	expect(resolveProviderIconId({ host: 'github.com' })).toBe('github')
	expect(resolveProviderIconId({ host: 'mcp.linear.app' })).toBe('linear')
	expect(resolveProviderIconId({ host: 'mcp.notion.com' })).toBe('notion')
	expect(resolveProviderIconId({ host: 'api.dropboxapi.com' })).toBe('dropbox')
	expect(resolveProviderIconId({ host: 'identity.xero.com' })).toBe('xero')
	expect(
		resolveProviderIconId({ host: 'fleet-api.prd.na.vn.cloud.tesla.com' }),
	).toBe('tesla')
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
			providerKey: 'dropbox',
			logoPath: '/integrations/logos/dropbox?v=1',
			autoLogoPath: '/integrations/logos/dropbox?v=2',
		}),
	).toBe('upload')
	expect(
		resolveProviderMarkSource({
			providerKey: 'dropbox',
			autoLogoPath: '/integrations/logos/dropbox?v=2',
		}),
	).toBe('catalog')
	expect(
		resolveProviderMarkSource({
			providerKey: 'obscure-crm',
			host: 'login.unknown.test',
			autoLogoPath: '/integrations/logos/obscure-crm?v=2',
		}),
	).toBe('favicon')
	expect(
		resolveProviderMarkSource({
			providerKey: 'obscure-crm',
			host: 'login.unknown.test',
		}),
	).toBe('letter')
})
