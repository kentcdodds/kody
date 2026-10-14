import { expect, test } from 'vitest'
import { resolveProviderMarkSource } from './provider-icons.tsx'

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
