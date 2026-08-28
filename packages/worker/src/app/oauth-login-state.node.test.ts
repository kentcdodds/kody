import { expect, test } from 'vitest'
import {
	createOauthLoginStateCookie,
	readOauthLoginState,
	setOauthLoginStateSecret,
} from './oauth-login-state.ts'

setOauthLoginStateSecret('test-cookie-secret-for-oauth-login-state')

test('oauth login state cookie preserves first-touch UTMs through round-trip', async () => {
	const attribution = {
		utmSource: 'youtube',
		utmMedium: 'video',
		utmCampaign: 'bwk-2026-08-27',
		utmContent: null,
		utmTerm: null,
		landingPath: '/signup',
		referrer: 'https://youtube.com/',
	}
	const cookie = await createOauthLoginStateCookie(
		{
			provider: 'github',
			state: 'csrf-state',
			codeVerifier: 'pkce-verifier',
			redirectTo: '/onboarding',
			inviteCode: 'YOUTUBE-FRIEND',
			attribution,
		},
		false,
	)
	const request = new Request('https://example.com/auth/github/callback', {
		headers: { Cookie: cookie.split(';')[0]! },
	})
	const restored = await readOauthLoginState(request)
	expect(restored).toEqual({
		provider: 'github',
		state: 'csrf-state',
		codeVerifier: 'pkce-verifier',
		redirectTo: '/onboarding',
		inviteCode: 'YOUTUBE-FRIEND',
		attribution: {
			utmSource: 'youtube',
			utmMedium: 'video',
			utmCampaign: 'bwk-2026-08-27',
			utmContent: null,
			utmTerm: null,
			landingPath: '/signup',
			referrer: 'https://youtube.com/',
		},
	})
})

test('oauth login state without attribution still reads (backwards compatible)', async () => {
	const cookie = await createOauthLoginStateCookie(
		{
			provider: 'google',
			state: 'state-2',
			codeVerifier: 'verifier-2',
			redirectTo: null,
			inviteCode: null,
			attribution: null,
		},
		false,
	)
	const request = new Request('https://example.com/callback', {
		headers: { Cookie: cookie.split(';')[0]! },
	})
	const restored = await readOauthLoginState(request)
	expect(restored?.attribution).toBeNull()
	expect(restored?.provider).toBe('google')
})
