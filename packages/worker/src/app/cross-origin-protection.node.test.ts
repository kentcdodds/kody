import { expect, test } from 'vitest'
import { createRouter } from 'remix/router'
import { remixCrossOriginProtection } from './cross-origin-protection.ts'

function createStubHandler(name: string) {
	return {
		middleware: [],
		async handler() {
			return new Response(name)
		},
	}
}

test('COP rejects cross-site app posts and bypasses webhook and sentry posts', async () => {
	const router = createRouter({
		middleware: [remixCrossOriginProtection],
	})
	router.post('/account/profile.json', createStubHandler('profile'))
	router.post('/webhooks/stripe', createStubHandler('stripe'))
	router.post(
		'/@kentcdodds/webhooks/pkg/hook/secret',
		createStubHandler('hook'),
	)
	router.post('/sentry-tunnel', createStubHandler('sentry'))
	router.get('/account', createStubHandler('account-get'))

	const sameOrigin = await router.fetch(
		new Request('http://localhost/account/profile.json', {
			method: 'POST',
			headers: {
				Origin: 'http://localhost',
				'Sec-Fetch-Site': 'same-origin',
			},
		}),
	)
	expect(await sameOrigin.text()).toBe('profile')

	const crossSite = await router.fetch(
		new Request('http://localhost/account/profile.json', {
			method: 'POST',
			headers: {
				Origin: 'https://evil.example',
				'Sec-Fetch-Site': 'cross-site',
			},
		}),
	)
	expect(crossSite.status).toBe(403)

	const getAllowed = await router.fetch(
		new Request('http://localhost/account', {
			headers: {
				Origin: 'https://evil.example',
				'Sec-Fetch-Site': 'cross-site',
			},
		}),
	)
	expect(await getAllowed.text()).toBe('account-get')

	const stripe = await router.fetch(
		new Request('http://localhost/webhooks/stripe', {
			method: 'POST',
			headers: {
				Origin: 'https://js.stripe.com',
				'Sec-Fetch-Site': 'cross-site',
			},
		}),
	)
	expect(await stripe.text()).toBe('stripe')

	const hook = await router.fetch(
		new Request('http://localhost/@kentcdodds/webhooks/pkg/hook/secret', {
			method: 'POST',
			headers: {
				Origin: 'https://hooks.example',
				'Sec-Fetch-Site': 'cross-site',
			},
		}),
	)
	expect(await hook.text()).toBe('hook')

	const sentry = await router.fetch(
		new Request('http://localhost/sentry-tunnel', {
			method: 'POST',
			headers: {
				Origin: 'https://evil.example',
				'Sec-Fetch-Site': 'cross-site',
			},
		}),
	)
	expect(await sentry.text()).toBe('sentry')
})
