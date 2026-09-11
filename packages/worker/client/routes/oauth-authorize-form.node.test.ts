import { expect, test } from 'vitest'
import {
	oauthAuthorizeActionsDisabled,
	oauthAuthorizeApproveAriaLabel,
	oauthAuthorizeConsentFormAttrs,
} from './oauth-authorize-form.ts'

test('authorize consent form defaults preserve the OAuth query on native submit', () => {
	const search =
		'?response_type=code&client_id=demo&state=abc&code_challenge=xyz'
	const href = `/oauth/authorize${search}`

	expect(oauthAuthorizeConsentFormAttrs(href)).toEqual({
		method: 'post',
		action: href,
	})
	expect(oauthAuthorizeConsentFormAttrs(`https://kody.codes${href}`)).toEqual({
		method: 'post',
		action: href,
	})

	expect(
		oauthAuthorizeActionsDisabled({
			hydrated: false,
			statusReady: true,
			submitting: false,
			sessionLoading: false,
			needsEmailVerification: false,
		}),
	).toBe(true)
	expect(
		oauthAuthorizeActionsDisabled({
			hydrated: true,
			statusReady: true,
			submitting: false,
			sessionLoading: false,
			needsEmailVerification: false,
		}),
	).toBe(false)
	expect(
		oauthAuthorizeActionsDisabled({
			hydrated: true,
			statusReady: false,
			submitting: false,
			sessionLoading: false,
			needsEmailVerification: false,
		}),
	).toBe(true)

	expect(
		oauthAuthorizeApproveAriaLabel({
			hydrated: false,
			label: 'Approve connection',
		}),
	).toBe('Approve connection (available after the page finishes loading)')
	expect(
		oauthAuthorizeApproveAriaLabel({
			hydrated: true,
			label: 'Approve connection',
		}),
	).toBeUndefined()
})
