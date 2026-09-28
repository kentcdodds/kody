import { expect, test } from 'vitest'
import { creditTopUpSuccessUrl } from '#worker/billing/credit-top-ups.ts'
import {
	accountCreditsRedirectUrl,
	createAccountCreditsHandler,
} from './account-credits.ts'

test('old /account/credits links land on the usage Credits section', async () => {
	const request = new Request('https://kody.codes/account/credits')
	const response = await createAccountCreditsHandler().handler({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe(
		'https://kody.codes/account/usage#credits',
	)
})

test('the redirect keeps pre-move Stripe returns and notice codes', () => {
	expect(
		accountCreditsRedirectUrl(
			'https://kody.codes/account/credits?topup=success&session_id=cs_123',
		),
	).toBe(
		'https://kody.codes/account/usage?topup=success&session_id=cs_123#credits',
	)
	expect(
		accountCreditsRedirectUrl(
			'https://kody.codes/account/credits?credits=added',
		),
	).toBe('https://kody.codes/account/usage?credits=added#credits')
})

test('top-up success URL drops the fragment so Stripe can append the session id', () => {
	expect(
		creditTopUpSuccessUrl('https://kody.codes/account/usage#credits'),
	).toBe(
		'https://kody.codes/account/usage?topup=success&session_id={CHECKOUT_SESSION_ID}',
	)
})
