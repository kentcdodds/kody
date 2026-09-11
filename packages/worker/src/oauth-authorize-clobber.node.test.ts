import { expect, test } from 'vitest'
import { honeypotFieldName } from '#universal/public-form-protection.ts'
import { isOAuthAuthorizeClobberedResubmit } from './oauth-authorize-clobber.ts'

test('authorize clobber detection is the honeypot-only missing-client_id case', () => {
	expect(
		isOAuthAuthorizeClobberedResubmit({
			searchParams: new URLSearchParams(`${honeypotFieldName}=`),
		}),
	).toBe(true)
	expect(
		isOAuthAuthorizeClobberedResubmit({
			searchParams: new URLSearchParams(),
			formData: new FormData(),
		}),
	).toBe(false)

	const formData = new FormData()
	formData.set(honeypotFieldName, '')
	expect(
		isOAuthAuthorizeClobberedResubmit({
			searchParams: new URLSearchParams(),
			formData,
		}),
	).toBe(true)
	expect(
		isOAuthAuthorizeClobberedResubmit({
			searchParams: new URLSearchParams(`client_id=demo&${honeypotFieldName}=`),
			formData,
		}),
	).toBe(false)
})
