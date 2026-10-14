import { expect, test } from 'vitest'
import {
	packageAppCustomDomainsCnameTarget,
	packageAppCustomDomainsCnameTargetFromBaseUrl,
} from '#worker/package-app-custom-hostnames/cname-target.ts'

test('packageAppCustomDomainsCnameTarget prefixes domains.', () => {
	expect(packageAppCustomDomainsCnameTarget('kody.run')).toBe(
		'domains.kody.run',
	)
	expect(packageAppCustomDomainsCnameTarget('kodyapps.dev')).toBe(
		'domains.kodyapps.dev',
	)
})

test('packageAppCustomDomainsCnameTargetFromBaseUrl reads the host', () => {
	expect(
		packageAppCustomDomainsCnameTargetFromBaseUrl('https://kody.run'),
	).toBe('domains.kody.run')
	expect(packageAppCustomDomainsCnameTargetFromBaseUrl('')).toBeNull()
	expect(packageAppCustomDomainsCnameTargetFromBaseUrl(null)).toBeNull()
	expect(packageAppCustomDomainsCnameTargetFromBaseUrl('not a url')).toBeNull()
})
