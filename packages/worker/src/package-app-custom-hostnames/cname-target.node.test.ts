import { expect, test } from 'vitest'
import { packageAppCustomDomainsCnameTargetFromBaseUrl } from '#worker/package-app-custom-hostnames/cname-target.ts'

test('packageAppCustomDomainsCnameTargetFromBaseUrl reads the host', () => {
	expect(
		packageAppCustomDomainsCnameTargetFromBaseUrl('https://kody.run'),
	).toBe('domains.kody.run')
	expect(packageAppCustomDomainsCnameTargetFromBaseUrl('')).toBeNull()
	expect(packageAppCustomDomainsCnameTargetFromBaseUrl(null)).toBeNull()
	expect(packageAppCustomDomainsCnameTargetFromBaseUrl('not a url')).toBeNull()
})
