import { expect, test } from 'vitest'
import {
	oauthAuthorizeActionsDisabled,
	oauthAuthorizeApproveAriaLabel,
	oauthAuthorizeConsentFormAttrs,
	oauthAuthorizeEmailVerificationDenyDisabled,
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

	// Consent actions stay disabled until hydration and a ready status.
	const actions: Array<[boolean, boolean, boolean]> = [
		[false, true, true],
		[true, true, false],
		[true, false, true],
	]
	expect(
		actions.filter(
			([hydrated, statusReady, want]) =>
				oauthAuthorizeActionsDisabled({
					hydrated,
					statusReady,
					submitting: false,
					sessionLoading: false,
					needsEmailVerification: false,
				}) !== want,
		),
	).toEqual([])

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

	const deny: Array<[boolean, boolean, boolean]> = [
		[false, false, true],
		[true, false, false],
		[true, true, true],
	]
	expect(
		deny.filter(
			([hydrated, submitting, want]) =>
				oauthAuthorizeEmailVerificationDenyDisabled({
					hydrated,
					submitting,
					sessionLoading: false,
				}) !== want,
		),
	).toEqual([])
})
